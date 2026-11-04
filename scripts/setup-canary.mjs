#!/usr/bin/env node
/**
 * Sets up dictation with NVIDIA Canary-Qwen 2.5B: its own Python, PyTorch and
 * NeMo, all inside <project>/.canary (ignored by git; several GB, and the model
 * itself downloads on first use). Needs uv (https://docs.astral.sh/uv/).
 *
 *   npm run setup:canary
 *
 * PyTorch's CUDA 12.6 build, the newest that still runs older cards (GTX 10xx).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.canary');
fs.mkdirSync(dir, { recursive: true });
const python = path.join(dir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const env = { ...process.env, UV_CACHE_DIR: path.join(dir, 'uv-cache'), UV_PYTHON_INSTALL_DIR: path.join(dir, 'python') };

function run(file, args) {
  console.log(`\n> ${file} ${args.join(' ')}`);
  const result = spawnSync(file, args, { cwd: dir, env, stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') {
    console.error(`${file} wasn't found. Install it and run this again.`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

if (!fs.existsSync(python)) run('uv', ['venv', '--python', '3.11', 'venv']);
run('uv', ['pip', 'install', '--python', python, 'torch==2.7.1', 'torchaudio==2.7.1', '--index-url', 'https://download.pytorch.org/whl/cu126']);
run('uv', ['pip', 'install', '--python', python, 'nemo_toolkit[asr] @ git+https://github.com/NVIDIA/NeMo.git', 'peft', 'soundfile']);
run(python, ['-c', "import torch; from nemo.collections.speechlm2.models import SALM; print('Ready. GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none (it will be slow)')"]);
console.log('\nDone. The model downloads the first time you dictate (several GB).');
