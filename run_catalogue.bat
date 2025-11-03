@echo off
rem --- Batch Script to Compile and Run CatalogueManager.java ---

rem Check if Java is in the path
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

rem --- 2. Run the compiled Java class (DEBUG MODE: using 'java' and 'pause' to show errors) ---
echo Compilation successful. Launching application...
echo.

rem java executes the application and shows console output for debugging.
java CatalogueManager

rem --- Pause after execution to read any runtime error messages ---
pause

exit /b 0