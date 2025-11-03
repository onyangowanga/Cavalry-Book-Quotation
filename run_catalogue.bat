@echo off
rem --- Batch Script to Compile and Run CatalogueManager.java ---

rem Check if java is in the path
where java >nul 2>nul
if %errorlevel% neq 0 (
echo.
echo ERROR: Java is not found in your system's PATH.
echo Please ensure the Java Development Kit (JDK) is installed and configured correctly.
pause
exit /b 1
)

rem --- 1. Compile the Java file ---
echo Compiling CatalogueManager.java...
javac CatalogueManager.java

if %errorlevel% neq 0 (
echo.
echo COMPILATION FAILED. Check the errors above.
pause
exit /b 1
)

rem --- 2. Run the compiled Java class ---
echo Compilation successful. Running application...
echo.

rem The application is run without showing the console window in the foreground
rem once the Swing GUI is launched.
java CatalogueManager

rem --- PAUSE ADDED HERE TO KEEP WINDOW OPEN AFTER EXECUTION ---
echo.
echo Application execution finished. Press any key to close this window...
pause

exit /b 0