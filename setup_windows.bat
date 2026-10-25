@echo off
chcp 65001 >nul
echo ===================================================
echo   FC Sniper - Configurazione Auto-Updater Windows  
echo ===================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "LOCAL_DATA=%LOCALAPPDATA%\FC26Sniper\NativeMessagingHosts"

if not exist "%LOCAL_DATA%" (
    mkdir "%LOCAL_DATA%" 2>nul
)

set "HOST_JSON=%LOCAL_DATA%\com.fc26sniper.updater.json"
set "BAT_PATH=%SCRIPT_DIR%\updater_host.bat"

REM Escape backslashes for JSON
set "BAT_PATH_JSON=%BAT_PATH:\=\\%"

echo Generazione file manifest: "%HOST_JSON%"
(
echo {
echo   "name": "com.fc26sniper.updater",
echo   "description": "FC Sniper & Trader Native Auto-Updater Host",
echo   "path": "%BAT_PATH_JSON%",
echo   "type": "stdio",
echo   "allowed_origins": [
echo     "chrome-extension://omnaoogbggapphajhlkjnedcljihpdhe/"
echo   ]
echo }
) > "%HOST_JSON%"

echo Registrazione nel Registro di Windows (Google Chrome)...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.fc26sniper.updater" /ve /t REG_SZ /d "%HOST_JSON%" /f >nul
if %errorlevel% equ 0 (
    echo [OK] Chrome configurato con successo.
) else (
    echo [ERRORE] Impossibile configurare Chrome.
)

echo Registrazione nel Registro di Windows (Microsoft Edge)...
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.fc26sniper.updater" /ve /t REG_SZ /d "%HOST_JSON%" /f >nul
if %errorlevel% equ 0 (
    echo [OK] Edge configurato con successo.
)

echo.
echo ===================================================
echo   Configurazione completata con successo!
echo   Riavvia o ricarica l'estensione in Chrome (F5)
echo ===================================================
echo.
pause
