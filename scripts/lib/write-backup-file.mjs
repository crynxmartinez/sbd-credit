import { closeSync, openSync, writeSync } from "node:fs";

/**
 * Writes a backup as JSON one section at a time, and one row per line.
 *
 * `JSON.stringify(wholeBackup, null, 2)` builds a single string in memory, and V8 refuses a string past about half a billion
 * characters: a backup with a million-odd rows would simply fail. Here no string is larger than one row, so the size of the
 * backup is limited by the disk, not by memory. The result is ordinary JSON that JSON.parse (and the restore) read as before.
 */
export function writeBackupJson(path, file, mode = 0o600) {
  const fd = openSync(path, "w", mode);
  try {
    const out = (text) => writeSync(fd, text);
    const keys = Object.keys(file);
    out("{\n");
    keys.forEach((key, keyIndex) => {
      const value = file[key];
      out(`  ${JSON.stringify(key)}: `);
      if (Array.isArray(value)) {
        if (value.length === 0) out("[]");
        else {
          out("[\n");
          value.forEach((row, index) => out(`    ${JSON.stringify(row)}${index < value.length - 1 ? "," : ""}\n`));
          out("  ]");
        }
      } else {
        out(JSON.stringify(value));
      }
      out(keyIndex < keys.length - 1 ? ",\n" : "\n");
    });
    out("}\n");
  } finally {
    closeSync(fd);
  }
}
