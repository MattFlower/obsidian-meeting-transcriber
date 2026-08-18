"""Deterministic test, typecheck, and build blocks.

A known command is not a judgement call. Anything whose invocation you can write
down belongs here as code — it runs in milliseconds, costs nothing, and returns
the same answer every time. Agents are for the parts that need reading and
deciding.

Wired for the TYPESCRIPT toolchain — the deliverable is an Obsidian plugin
(manifest.json + a bundled main.js, loaded by Electron). Three blocks:
`npm test`, `npx tsc --noEmit`, and `npm run build`.

Two deliberate choices:

`npx tsc --noEmit` is the typecheck rather than a bundler flag because it needs
nothing but a tsconfig.json — it is the one check that works before the build
script exists, and it is the only one that reads every file rather than just
those the bundler happens to reach from the entry point.

There is no lint block. The scaffold does not exist yet, so any `npm run lint`
would be a guess at a script name, and a block that fails because a script is
missing reports a tooling gap as a code defect. Add one once the project has a
linter — that is a real signal, where this would have been noise.

These blocks run against package.json scripts, so they follow whatever the
project settles on; `npm` is used as the invoker because it is present and
reads the same `scripts` block every JS toolchain writes.

Every npm block passes `--prefix <repo_root>`. Without it npm walks UP from the
cwd looking for a package.json and will happily run a script from a parent
directory — observed here reaching `/Users/mflower/package.json` before this
project had a package.json of its own. A quality block that reports on someone
else's project is worse than one that fails.

Two rules when you edit a command here:
  1. argv LIST, never a shell string — no quoting bugs, no shell injection.
  2. Call binaries by BARE NAME. These blocks inherit the operator's
     environment (see utils.operator_env), so `npm` and `npx` resolve exactly
     as they do in their terminal. Never hard-code an absolute path like
     /Users/you/.nvm/versions/node/bin/npm — that bakes your machine into the
     trace.

Delete a block you don't want, and drop it from run_quality()'s list too.
"""

from __future__ import annotations

import shlex
import subprocess
import time
from pathlib import Path
from typing import Callable

from .data_types import (EventRecord, QualityCheckResult, QualityCheckSpec, QualityResult,
                         VerifyOutput)
from .utils import now_iso, operator_env

# How much of a failing command's output rides back inside the envelope. Enough
# for a builder to act on without opening the artifact; bounded so a runaway
# stack trace can't swamp the next agent's context.
TAIL_CHARS = 4_000


# A cold node_modules turns any of these into an install first, and tsc over a
# fresh dependency graph is not fast. 120s (the QualityCheckSpec default) is too
# tight to distinguish "slow" from "wedged" on a first run.
BUILD_TIMEOUT = 600


def _check_dir(run, name: str) -> Path:
    seq = run.phases[-1].seq if run.phases else 0
    path = run.context_handoff_dir / "quality" / f"{seq:02d}_{name}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _run(spec: QualityCheckSpec, run) -> QualityCheckResult:
    phase = run.phases[-1]
    output_dir = _check_dir(run, spec.name)
    output_artifact = output_dir / "command.log"
    command = shlex.join(spec.argv)
    env = operator_env()             # the engineer's own shell environment

    run.console.note(f"quality {spec.name}: {command}")
    started_at = now_iso()
    clock = time.monotonic()
    stdout = ""
    stderr = ""
    try:
        completed = subprocess.run(
            spec.argv,
            cwd=run.repo_root,
            env=env,
            capture_output=True,
            text=True,
            timeout=spec.timeout_seconds,
        )
        returncode = completed.returncode
        stdout = completed.stdout
        stderr = completed.stderr
    except subprocess.TimeoutExpired as error:
        returncode = 124
        stdout = error.stdout or ""
        stderr = (error.stderr or "") + f"\nTimed out after {spec.timeout_seconds}s."
    except OSError as error:
        # A missing binary lands here as exit 127 with the real message — no
        # pre-flight probe needed, and none wanted.
        returncode = 127
        stderr = str(error)

    duration = time.monotonic() - clock
    output_artifact.write_text(
        f"$ {command}\nexit: {returncode}\nduration_seconds: {duration:.3f}\n"
        f"\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}\n"
    )
    passed = returncode == 0
    run.tracer.event(EventRecord(
        adw_id=run.adw_id,
        phase_id=phase.phase_id,
        type="tool_call",
        name=f"quality:{spec.name}",
        payload={
            "area": spec.area,
            "operation": spec.operation,
            "command": command,
            "returncode": returncode,
            "passed": passed,
            "output_artifact": str(output_artifact),
        },
        started_at=started_at,
        ended_at=now_iso(),
    ))
    run.console.note(
        f"quality {spec.name}: {'passed' if passed else 'failed'} "
        f"(exit {returncode}, {duration:.1f}s)"
    )
    return QualityCheckResult(
        name=spec.name,
        area=spec.area,
        operation=spec.operation,
        command=command,
        returncode=returncode,
        passed=passed,
        duration_seconds=duration,
        output_artifact=str(output_artifact),
        output_tail=(stdout + stderr)[-TAIL_CHARS:],
    )


# ── Blocks ────────────────────────────────────────────────────────────────────

def test(run) -> QualityCheckResult:
    """`npm test` — whatever the project's test script runs.

    npm exits non-zero when the script is missing, so a project that never wired
    a test script fails here rather than passing silently. That is the intended
    reading: an unverified plugin is not a passing one.
    """
    return _run(QualityCheckSpec(
        name="test",
        area="frontend",
        operation="build",
        argv=["npm", "--prefix", str(run.repo_root), "test"],
        timeout_seconds=BUILD_TIMEOUT,
    ), run)


def typecheck(run) -> QualityCheckResult:
    """`tsc --noEmit` — type errors only, no output written.

    --noEmit matters beyond speed: a typecheck that emitted files would leave
    build output no agent claimed, which permissions.py would then roll back.
    """
    return _run(QualityCheckSpec(
        name="typecheck",
        area="frontend",
        operation="typecheck",
        argv=["npx", "tsc", "--noEmit"],
        timeout_seconds=BUILD_TIMEOUT,
    ), run)


def build(run) -> QualityCheckResult:
    """`npm run build` — bundle the plugin the way Obsidian will load it.

    Typechecking clean and bundling clean are different claims: the bundler
    resolves every import and asset for real, which is where a plugin that
    compiles but cannot load shows itself.
    """
    return _run(QualityCheckSpec(
        name="build",
        area="frontend",
        operation="build",
        argv=["npm", "--prefix", str(run.repo_root), "run", "build"],
        timeout_seconds=BUILD_TIMEOUT,
    ), run)


def run_tests(run) -> QualityResult:
    """The test suite alone, as a QualityResult — the deterministic test phase.

    This is what replaces a `tester` agent once the command is written down. An
    agent rediscovering the runner on every run costs a fortune to learn what a
    subprocess already knows; the repair loop is unchanged, because a failure
    still reaches the builder through `as_envelope` below.
    """
    check = test(run)
    failures = ([] if check.passed else
                [f"{check.name}: `{check.command}` exited {check.returncode}\n"
                 f"{check.output_tail}".rstrip()])
    return QualityResult(passed=check.passed, checks=[check], failures=failures,
                         artifacts=[check.output_artifact])


def as_envelope(result: QualityResult, what: str) -> VerifyOutput:
    """Wrap a deterministic result so an agent can be handed it directly.

    Agents hand each other typed envelopes; code blocks return QualityResult.
    This is the adapter, so a failing lint or test run flows back into the
    builder through exactly the same door an agent's report would — the ADW
    script is the only thing that knows the difference.
    """
    return VerifyOutput(
        status="success" if result.passed else "fail",
        summary=(f"{what}: all {len(result.checks)} check(s) passed" if result.passed
                 else f"{what}: {len(result.failures)} of {len(result.checks)} check(s) failed"),
        artifacts=result.artifacts,
        notes_for_next_agent=("" if result.passed else
                              "Fix every failure below. The output is verbatim from the "
                              "command — trust it over any summary."),
        passed=result.passed,
        failures=result.failures,
    )


def run_quality(run) -> QualityResult:
    """Run every block and collect ALL failures — one pass tells you everything.

    Ordering contract for the caller: a failing block does NOT fail the phase.
    The runner did its job; the CODE is what failed. Hand this result to the
    builder and let the bounded repair loop decide the run's fate.
    """
    blocks: list[Callable] = [
        test,
        typecheck,
        build,
    ]
    checks = [block(run) for block in blocks]
    # A failure is the command, its exit code, and what it actually printed —
    # everything a builder needs to repair without opening a log or being told
    # what the error "means" by a parser that guessed.
    failures = [
        f"{check.name}: `{check.command}` exited {check.returncode}\n{check.output_tail}".rstrip()
        for check in checks if not check.passed
    ]
    return QualityResult(
        passed=not failures,
        checks=checks,
        failures=failures,
        artifacts=[check.output_artifact for check in checks],
    )
