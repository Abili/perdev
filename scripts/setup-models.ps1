# Downloads the free models PerDev uses and builds the "perdev-coder" model.
# Models are stored on E: (OLLAMA_MODELS). Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-models.ps1

$ErrorActionPreference = 'Stop'
if (-not $env:OLLAMA_MODELS) { $env:OLLAMA_MODELS = 'E:\Tools\ollama-models' }

$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama) { $ollama = 'E:\Tools\Ollama\ollama.exe' }
if (-not (Test-Path $ollama)) { throw "Ollama not found. Install it first (see README)." }

try {
    Invoke-RestMethod http://localhost:11434/api/version | Out-Null
} catch {
    Write-Host 'Starting Ollama server...'
    Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
    Start-Sleep -Seconds 5
}

Write-Host 'Pulling chat/agent model (qwen2.5-coder:7b, ~4.7 GB)...'
& $ollama pull qwen2.5-coder:7b
Write-Host 'Pulling autocomplete model (qwen2.5-coder:1.5b-base, ~1 GB)...'
& $ollama pull qwen2.5-coder:1.5b-base
Write-Host 'Building perdev-coder from models\Modelfile...'
& $ollama create perdev-coder -f "$PSScriptRoot\..\models\Modelfile"
& $ollama list
