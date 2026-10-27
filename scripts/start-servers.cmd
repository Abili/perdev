@echo off
rem Starts PerDev's model servers by hand. The extension does this automatically
rem (perdev.server.autoStart); use this for testing outside VS Code.
set LLAMA=E:\Tools\llamacpp\llama-server.exe
set MODELS=E:\Tools\models
set DEVICE=Vulkan1

start "PerDev chat (8080)" "%LLAMA%" -m "%MODELS%\Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf" --host 127.0.0.1 --port 8080 --jinja -c 16384 --alias perdev-coder -ngl 99 --device %DEVICE%
start "PerDev autocomplete (8081)" "%LLAMA%" -m "%MODELS%\Qwen2.5-Coder-1.5B.Q4_K_M.gguf" --host 127.0.0.1 --port 8081 -c 4096 -np 1 -ngl 99 --device %DEVICE%
