param([string]$OutputDir = "")

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$dependencyDir = Join-Path $root "build\dependencies"
$classesDir = Join-Path $root "build\classes"
$libsDir = Join-Path $root "build\libs"
$apiJar = Join-Path $dependencyDir "spigot-api.jar"

New-Item -ItemType Directory -Force -Path $dependencyDir, $classesDir, $libsDir | Out-Null
if (-not (Test-Path -LiteralPath $apiJar)) {
    $metadataUrl = "https://hub.spigotmc.org/nexus/repository/snapshots/org/spigotmc/spigot-api/1.13.2-R0.1-SNAPSHOT/maven-metadata.xml"
    [xml]$metadata = (Invoke-WebRequest -UseBasicParsing -Uri $metadataUrl).Content
    $snapshot = $metadata.metadata.versioning.snapshotVersions.snapshotVersion |
        Where-Object { $_.extension -eq "jar" -and -not $_.classifier } |
        Select-Object -First 1
    if (-not $snapshot.value) { throw "Unable to resolve the Spigot API snapshot." }
    $jarUrl = "https://hub.spigotmc.org/nexus/repository/snapshots/org/spigotmc/spigot-api/1.13.2-R0.1-SNAPSHOT/spigot-api-$($snapshot.value).jar"
    Invoke-WebRequest -UseBasicParsing -Uri $jarUrl -OutFile $apiJar
}

Remove-Item -LiteralPath $classesDir -Recurse -Force
New-Item -ItemType Directory -Force -Path $classesDir | Out-Null
$sources = Get-ChildItem -LiteralPath (Join-Path $root "src\main\java") -Recurse -Filter "*.java" | ForEach-Object FullName
$argumentFile = Join-Path $root "build\javac.args"
$apiArgument = $apiJar.Replace('\', '/')
$classesArgument = $classesDir.Replace('\', '/')
$arguments = @("--release", "8", "-encoding", "UTF-8", "-classpath", "`"$apiArgument`"", "-d", "`"$classesArgument`"")
$arguments += $sources | ForEach-Object { "`"$($_.Replace('\', '/'))`"" }
[System.IO.File]::WriteAllLines($argumentFile, $arguments, [System.Text.UTF8Encoding]::new($false))
& javac "@$argumentFile"
if ($LASTEXITCODE -ne 0) { throw "javac failed with exit code $LASTEXITCODE" }
Copy-Item -LiteralPath (Join-Path $root "src\main\resources\plugin.yml") -Destination $classesDir -Force

$jarPath = Join-Path $libsDir "LauncherCompletionBridge.jar"
Remove-Item -LiteralPath $jarPath -Force -ErrorAction SilentlyContinue
$javacCommand = (Get-Command javac -ErrorAction Stop).Source
$jarCommand = Join-Path (Split-Path $javacCommand -Parent) "jar.exe"
if (-not (Test-Path -LiteralPath $jarCommand)) {
    $jarCommand = Get-ChildItem -LiteralPath (Join-Path $env:ProgramFiles "Java") -Recurse -Filter "jar.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $jarCommand -or -not (Test-Path -LiteralPath $jarCommand)) { throw "jar.exe was not found in the installed JDK" }
Push-Location $classesDir
try { & $jarCommand cf $jarPath . } finally { Pop-Location }
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $jarPath)) { throw "jar packaging failed" }

if (-not $OutputDir) { $OutputDir = Join-Path (Split-Path $root -Parent) "outputs\jars" }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$finalJar = Join-Path $OutputDir "LauncherCompletionBridge.jar"
Copy-Item -LiteralPath $jarPath -Destination $finalJar -Force
Get-Item -LiteralPath $finalJar | Select-Object FullName, Length, LastWriteTime
