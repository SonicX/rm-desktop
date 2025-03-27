@echo off
signtool sign /sha1 <ваш_отпечаток> /fd SHA256 /t http://timestamp.digicert.com /d "Связь РМ" /du "https://github.com/sg12/zulip-desktop#readme" %1
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%