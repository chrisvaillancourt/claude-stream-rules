// The bundled tool-routing ruleset: four rule files, loaded (as source
// `bundled`) only when the `toolRouting` option is on. They live in a module
// rather than on disk so the tests read exactly what ships; each is parsed by
// the same parseRule as a file in a rules folder, and a user or project file
// of the same name replaces it.

const BYPASS = 'If the shell form really is needed, run the same command again with a Bash description that starts with "[tool-routing bypass] " followed by the reason.'

export const TOOL_ROUTING: Readonly<Record<string, string>> = {
  'tool-routing-read.md': `---
name: tool-routing-read
description: Read files with the Read tool, not cat, head, tail, less or more
matcher: bash-native-read
scope: ['tool:Bash']
repeat: always
---
Use the Read tool to look at a file instead of cat, head, tail, less or more in Bash. For example: Read({ file_path: "/absolute/path/to/file", offset: 1, limit: 80 }). offset and limit choose lines; leave them out to read the whole file.
${BYPASS}
`,
  'tool-routing-edit.md': `---
name: tool-routing-edit
description: Change files with the Edit tool, not sed -i, perl -i or awk -i inplace
matcher: bash-native-edit
scope: ['tool:Bash']
repeat: always
---
Use the Edit tool to change a file instead of editing it in place from Bash. Read the file first, then: Edit({ file_path: "/absolute/path/to/file", old_string: "the exact text now in the file", new_string: "its replacement" }). Add replace_all: true to change every occurrence.
${BYPASS}
`,
  'tool-routing-search.md': `---
name: tool-routing-search
description: Search file contents with the Grep tool, not grep or rg
matcher: bash-native-search
scope: ['tool:Bash']
repeat: always
---
Use the Grep tool to search file contents instead of grep or rg in Bash.
${BYPASS}
`,
  'tool-routing-files.md': `---
name: tool-routing-files
description: Find files by name with the Glob tool, not find, fd or ls -R
matcher: bash-native-files
scope: ['tool:Bash']
repeat: always
---
Use the Glob tool to find files by name pattern instead of find, fd or ls -R in Bash.
${BYPASS}
`,
}
