---
description: Don't delete recursively from the shell
condition: '\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r)\b'
scope: ['tool:Bash']
---
Don't run `rm -rf`. Move the files to the trash instead (`trash <path>` on macOS), or ask before deleting.
