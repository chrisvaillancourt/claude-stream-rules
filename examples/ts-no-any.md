---
description: Prefer unknown or a real type to any in TypeScript
condition: [':\s*any\b', '\bas\s+any\b', '<any>']
scope: ['tool:Edit(*.{ts,tsx})', 'tool:Write(*.{ts,tsx})']
interrupt: false
repeat: after-gap
gap: 20
---
This edit adds `any`. Use `unknown` and narrow it, a domain type, or a generic, unless `any` is truly needed here.
