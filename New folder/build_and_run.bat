@echo off
echo Compiling...
javac *.java

if %errorlevel% neq 0 (
    echo Compilation failed! Check your code.
    pause
    exit /b
)

echo Bundling into JAR...
jar cvfm PrintingApp.jar manifest.txt *.class

echo Starting App...
java -jar PrintingApp.jar
pause