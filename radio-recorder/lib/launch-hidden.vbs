' Start the recorder service with no visible console window.
' Form 1: wscript.exe launch-hidden.vbs "<node.exe>" "<server.js>" "<working dir>"
' Form 2: no arguments - read FM990Recorder.ini next to this script (3 lines).
' Paths are passed as arguments / plain lines, so no quote escaping is needed.
Option Explicit
Dim sh, fso, q, cmdLine, nodeExe, serverJs, workDir, iniPath, ts
q = Chr(34)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count >= 3 Then
  nodeExe = WScript.Arguments(0)
  serverJs = WScript.Arguments(1)
  workDir = WScript.Arguments(2)
Else
  iniPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "FM990Recorder.ini")
  If Not fso.FileExists(iniPath) Then WScript.Quit 1
  Set ts = fso.OpenTextFile(iniPath, 1)
  If ts.AtEndOfStream Then WScript.Quit 1
  nodeExe = ts.ReadLine
  If ts.AtEndOfStream Then WScript.Quit 1
  serverJs = ts.ReadLine
  If ts.AtEndOfStream Then WScript.Quit 1
  workDir = ts.ReadLine
  ts.Close
End If
sh.CurrentDirectory = workDir
cmdLine = q & nodeExe & q & " " & q & serverJs & q
sh.Run cmdLine, 0, False
WScript.Quit 0
