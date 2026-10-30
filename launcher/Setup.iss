#ifndef Version
  #error Version is required
#endif
[Setup]
AppId=AIONWorkshop
AppName=AION Workshop
AppVersion={#Version}
AppPublisher=MrM0y
AppPublisherURL=https://github.com/MrM0y/aion-workshop
DefaultDirName={localappdata}\Programs\AION Workshop
DefaultGroupName=AION Workshop
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#Output}
OutputBaseFilename=AION-Workshop-Setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\AION-Workshop.exe
CloseApplications=yes
RestartApplications=no
AllowRootDirectory=no
AllowUNCPath=no

[Languages]
Name: "ukrainian"; MessagesFile: "compiler:Languages\Ukrainian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Ярлик на робочому столі"; Flags: unchecked

[Files]
Source: "{#Prepared}\AION-Workshop.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Prepared}\versions\*"; DestDir: "{app}\versions"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Prepared}\current.json"; DestDir: "{app}"; Flags: onlyifdoesntexist

[Icons]
Name: "{group}\AION Workshop"; Filename: "{app}\AION-Workshop.exe"
Name: "{autodesktop}\AION Workshop"; Filename: "{app}\AION-Workshop.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\AION-Workshop.exe"; Description: "Запустити AION Workshop"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\versions"
Type: files; Name: "{app}\current.json*"
Type: files; Name: "{app}\port.json*"
Type: files; Name: "{app}\running.json"
