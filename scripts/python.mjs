#!/usr/bin/env node
/**
 * Lanza un script de Python con el primer intérprete que de verdad funcione.
 *
 *   node scripts/python.mjs compute_metrics.py --all
 *
 * En Windows `python3` suele ser el stub de la Microsoft Store: existe en el
 * PATH, no ejecuta nada y sale con código 49. Un `predev` que lo invoque
 * directamente aborta y Vite nunca arranca. Aquí se prueba cada candidato con
 * `--version` y se descarta el que no responda, así el mismo package.json vale
 * en Windows, macOS y Linux.
 *
 * Se puede forzar uno concreto con la variable de entorno PYTHON.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

// `py -3` es el lanzador oficial de Windows y va al final como red de seguridad:
// resuelve la instalación real incluso cuando `python` es el stub.
const CANDIDATES = [
  process.env.PYTHON && [process.env.PYTHON, []],
  ["python3", []],
  ["python", []],
  ["py", ["-3"]],
].filter(Boolean);

function resolveInterpreter() {
  for (const [cmd, prefix] of CANDIDATES) {
    const probe = spawnSync(cmd, [...prefix, "--version"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    if (!probe.error && probe.status === 0) return [cmd, prefix];
  }
  return null;
}

const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error("uso: node scripts/python.mjs <script.py> [args...]");
  process.exit(2);
}

const scriptPath = path.join(SCRIPTS, script);
if (!existsSync(scriptPath)) {
  console.error(`no existe ${scriptPath}`);
  process.exit(2);
}

const found = resolveInterpreter();
if (!found) {
  const tried = CANDIDATES.map(([c, p]) => [c, ...p].join(" ")).join(", ");
  console.error(
    `\n  No se encontró un Python utilizable (probé: ${tried}).\n` +
      `  Instala Python 3 con h5py y numpy, o exporta PYTHON=<ruta al ejecutable>.\n`
  );
  process.exit(1);
}

const [cmd, prefix] = found;
const run = spawnSync(cmd, [...prefix, scriptPath, ...rest], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(run.status ?? 1);
