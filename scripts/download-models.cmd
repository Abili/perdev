@echo off
rem Downloads PerDev's free models (GGUF, Apache-2.0) to E:\Tools\models.
rem Resumes after dropped connections; safe to re-run.
setlocal
set DIR=E:\Tools\models
if not exist "%DIR%" mkdir "%DIR%"

call :get Qwen2.5-Coder-1.5B.Q4_K_M.gguf https://huggingface.co/QuantFactory/Qwen2.5-Coder-1.5B-GGUF/resolve/main/Qwen2.5-Coder-1.5B.Q4_K_M.gguf
call :get Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf
echo All models downloaded.
exit /b 0

:get
for /l %%i in (1,1,200) do (
  echo [%time%] %1 attempt %%i
  curl.exe -L --fail -C - --retry 5 --retry-delay 5 --speed-limit 1000 --speed-time 60 -o "%DIR%\%1" %2
  if not errorlevel 1 goto :eof
  rem 33 = nothing left to resume, file already complete
  if errorlevel 33 if not errorlevel 34 goto :eof
  timeout /t 10 /nobreak >nul
)
exit /b 1
