Make `npx tsc --noEmit` pass. It currently exits 2 with three errors, all of
them inside the Obsidian API's own shipped type definitions rather than this
plugin's source:

    node_modules/obsidian/obsidian.d.ts(4245,14): error TS2420: Class 'Menu' incorrectly implements interface 'HistoryHandler'.
      Property 'onHistoryBack' is missing in type 'Menu' but required in type 'HistoryHandler'.
    node_modules/obsidian/obsidian.d.ts(4477,14): error TS2420: Class 'Modal' incorrectly implements interface 'HistoryHandler'.
      Property 'onHistoryBack' is missing in type 'Modal' but required in type 'HistoryHandler'.
    node_modules/obsidian/obsidian.d.ts(5201,23): error TS2420: Class 'PopoverSuggest<T>' incorrectly implements interface 'HistoryHandler'.
      Property 'onHistoryBack' is missing in type 'PopoverSuggest<T>' but required in type 'HistoryHandler'.

Running the same command with `--skipLibCheck` exits 0, so every file under
src/ already typechecks clean. Nothing in this plugin's own code is broken.

Where: tsconfig.json

Done means: `npx tsc --noEmit` exits 0 and reports no errors, and `npm test`
and `npm run build` both still pass.

Out of scope: weakening this plugin's own type checking to get there —
strictNullChecks stays on, and no `any`, `@ts-ignore`, or `@ts-expect-error`
added anywhere in src/. Do not edit files in node_modules/, and do not modify
adws/ or .claude/.
