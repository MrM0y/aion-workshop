using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Framework 4.8 is included in supported Windows 10/11. No Node installation is needed.
internal static class Launcher {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    static string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AIONWorkshop");
    static string Repository, EmbeddedVersion, Url;
    static Process Child;
    static NotifyIcon Tray;
    static Form Splash;
    static Label Status;
    static Mutex Lock;
    static bool Exiting, NoBrowser;
    static string Executable { get { return Assembly.GetExecutingAssembly().Location; } }
    static string Pointer { get { return Path.Combine(Root, "current.json"); } }
    static string PortFile { get { return Path.Combine(Root, "port.json"); } }

    [STAThread] static int Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        try {
            int profileIndex=Array.IndexOf(args,"--profile-dir");
            if(profileIndex>=0){if(profileIndex+1>=args.Length||Array.LastIndexOf(args,"--profile-dir")!=profileIndex)throw new Exception("Потрібна одна повна папка після --profile-dir.");Root=ProfileRoot(args[profileIndex+1]);}
            NoBrowser=args.Contains("--no-browser");
            var config = ReadObject(ResourceText("launcher.json"));
            Repository = Text(config, "repository"); EmbeddedVersion = Text(config, "version");
            if (!Regex.IsMatch(Repository, @"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") || !ValidVersion(EmbeddedVersion)) throw new Exception("Некоректна конфігурація збірки.");
            if (args.Contains("--self-test")) return SelfTest();
            // This CLI path supports release smoke tests without personal state or browser interaction.
            int extractIndex = Array.IndexOf(args, "--extract-only");
            if (extractIndex >= 0) {
                if (args.Length != extractIndex + 2) throw new Exception("Потрібна нова порожня папка після --extract-only.");
                string destination = Path.GetFullPath(args[extractIndex + 1]);
                if (Directory.Exists(destination)) throw new Exception("Папка вже існує.");
                ExtractEmbedded(destination); return 0;
            }
            Directory.CreateDirectory(Root);
            bool owns; Lock = new Mutex(true, MutexName(), out owns);
            if (!owns) { OpenExisting(); return 0; }
            Splash = new Form { Text="AION Workshop", Width=470, Height=135, StartPosition=FormStartPosition.CenterScreen, FormBorderStyle=FormBorderStyle.FixedDialog, MaximizeBox=false, MinimizeBox=false, ControlBox=false };
            Status = new Label { AutoSize=false, Dock=DockStyle.Fill, Padding=new Padding(20), Text="Відкриваю майстерню…" }; Splash.Controls.Add(Status); Splash.Show(); Application.DoEvents();
            string version = InstalledVersion();
            string previousVersion=version??EmbeddedVersion;
            if (version == null || new Version(EmbeddedVersion)>new Version(version)) { version=EmbeddedVersion; InstallEmbedded(version); }
            version = CheckUpdate(version, false);
            try { StartApp(version); }
            catch { if(version==previousVersion)throw;KillChild();SetCurrent(previousVersion);version=previousVersion;StartApp(version);MessageBox.Show("Нова версія не запустилася. Повернув попередню; твої дані збережено.","AION Workshop"); }
            Tray = new NotifyIcon { Icon=SystemIcons.Application, Text="AION Workshop · " + version, Visible=true };
            var menu = new ContextMenuStrip(); menu.Items.Add("Відкрити", null, (s,e)=>OpenBrowser(Url)); menu.Items.Add("Перевірити оновлення",null,(s,e)=>ManualUpdate(version)); menu.Items.Add("Завершити роботу",null,(s,e)=>Application.Exit()); Tray.ContextMenuStrip=menu; Tray.DoubleClick+=(s,e)=>OpenBrowser(Url);
            Application.ApplicationExit+=(s,e)=>Shutdown();
            Splash.Close(); Splash.Dispose(); Splash=null; OpenBrowser(Url); Application.Run();
            return 0;
        } catch(Exception error) { Shutdown(); if(!args.Contains("--self-test")&&!args.Contains("--extract-only"))MessageBox.Show(error.Message,"AION Workshop",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1; }
        finally { if(Lock!=null)Lock.Dispose(); }
    }

    static void Say(string message) { if(Status!=null&&!Status.IsDisposed){Status.Text=message;Application.DoEvents();} }
    static Dictionary<string,object> ReadObject(string text) { return Json.Deserialize<Dictionary<string,object>>(text); }
    static string Text(Dictionary<string,object> value,string key) { object found;return value!=null&&value.TryGetValue(key,out found)&&found is string?(string)found:null; }
    static bool ValidVersion(string version) { Version parsed;return version!=null&&Regex.IsMatch(version,@"^\d{1,4}\.\d{1,4}\.\d{1,4}$")&&Version.TryParse(version,out parsed); }
    // Explicit developer profiles keep upgrade QA away from the user's installed data.
    static string ProfileRoot(string directory) { if(directory==null||!Regex.IsMatch(directory,@"^[A-Za-z]:[\\/]"))throw new Exception("Для --profile-dir потрібен повний локальний шлях.");return Path.GetFullPath(directory); }
    static string MutexName() { using(var hash=SHA256.Create()){return @"Local\AIONWorkshopLauncher-"+BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(Root).ToUpperInvariant()))).Replace("-","").Substring(0,24);} }
    static bool ValidPort(int port) { return port>=1024&&port<=65535; }
    // Keep a stable browser origin on ordinary restarts so its recovery copy survives.
    static int SelectPort(string preferenceFile) {
        int preferred=0;
        try {
            if(new FileInfo(preferenceFile).Length<=4096){var saved=ReadObject(File.ReadAllText(preferenceFile));object raw;if(saved.TryGetValue("port",out raw)&&raw is int&&ValidPort((int)raw))preferred=(int)raw;}
        }catch{}
        TcpListener listener=null;
        try {
            if(preferred!=0){try{listener=new TcpListener(IPAddress.Loopback,preferred);listener.Start();}catch(SocketException){listener.Stop();listener=null;}}
            if(listener==null){listener=new TcpListener(IPAddress.Loopback,0);listener.Start();}
            int selected=((IPEndPoint)listener.LocalEndpoint).Port;
            if(!ValidPort(selected))throw new Exception("Не вдалося вибрати локальний порт.");
            Directory.CreateDirectory(Path.GetDirectoryName(preferenceFile));
            string temporary=preferenceFile+".new";File.WriteAllText(temporary,Json.Serialize(new{port=selected}),new UTF8Encoding(false));
            if(File.Exists(preferenceFile))File.Replace(temporary,preferenceFile,null);else File.Move(temporary,preferenceFile);
            return selected;
        } finally {if(listener!=null)listener.Stop();}
    }
    static string ResourceText(string name) { using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream(name)){if(stream==null)throw new Exception("Неповний launcher: "+name);using(var reader=new StreamReader(stream,Encoding.UTF8))return reader.ReadToEnd();} }
    static string VersionDirectory(string version) { if(!ValidVersion(version))throw new Exception("Некоректний номер версії.");return Path.Combine(Root,"versions",version); }
    static void ValidateInstalled(string folder,string version) {
        if(!File.Exists(Path.Combine(folder,"app","server.mjs"))||!File.Exists(Path.Combine(folder,"runtime","node.exe")))throw new Exception("Неповна програма в оновленні.");
        var manifest=ReadObject(File.ReadAllText(Path.Combine(folder,"app","package.json")));var config=ReadObject(File.ReadAllText(Path.Combine(folder,"app","release-config.json")));
        if(Text(manifest,"version")!=version||Text(config,"repository")!=Repository)throw new Exception("Версія або проєкт усередині оновлення не збігається з релізом.");
    }
    static bool Complete(string version) { try{string folder=VersionDirectory(version);ValidateInstalled(folder,version);return File.Exists(Path.Combine(folder,"installed.ok"));}catch{return false;} }
    static string InstalledVersion() {
        try { string version=Text(ReadObject(File.ReadAllText(Pointer)),"version");if(Complete(version))return version; }catch{}
        return Complete(EmbeddedVersion)?EmbeddedVersion:null;
    }
    static void SetCurrent(string version) {
        string temporary=Pointer+".new";File.WriteAllText(temporary,Json.Serialize(new{version=version}),new UTF8Encoding(false));
        if(File.Exists(Pointer))File.Replace(temporary,Pointer,Pointer+".backup",true);else File.Move(temporary,Pointer);
    }
    static void ExtractEmbedded(string destination) { using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")){if(stream==null)throw new Exception("Немає вбудованої програми.");string expected=Text(ReadObject(ResourceText("launcher.json")),"payloadSha256");using(var sha=SHA256.Create()){if(BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant()!=expected)throw new Exception("Вбудована програма пошкоджена. Завантаж launcher ще раз.");}stream.Position=0;Extract(stream,destination);ValidateInstalled(destination,EmbeddedVersion);} }
    static void InstallEmbedded(string version) {
        Say("Розпаковую програму. Це потрібно лише один раз…");
        string destination=VersionDirectory(version),staging=destination+".stage-"+Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(Path.GetDirectoryName(destination));
        try { ExtractEmbedded(staging);File.WriteAllText(Path.Combine(staging,"installed.ok"),version);if(Directory.Exists(destination))Directory.Move(destination,destination+".incomplete-"+Guid.NewGuid().ToString("N"));Directory.Move(staging,destination);SetCurrent(version); }
        finally { if(Directory.Exists(staging))Directory.Delete(staging,true); }
    }
    static void Extract(Stream input,string destination) {
        string root=Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
        Directory.CreateDirectory(root);long total=0;var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using(var zip=new ZipArchive(input,ZipArchiveMode.Read,true)) {
            if(zip.Entries.Count>20000)throw new Exception("Забагато файлів в оновленні.");
            foreach(var entry in zip.Entries){
                string relative=entry.FullName.Replace('/',Path.DirectorySeparatorChar),target=Path.GetFullPath(Path.Combine(root,relative));
                if(!target.StartsWith(root,StringComparison.OrdinalIgnoreCase)||relative.Contains(":")||!seen.Add(target))throw new Exception("Небезпечний шлях в архіві.");
                if(entry.Length>200L*1024*1024||(total+=entry.Length)>1024L*1024*1024)throw new Exception("Архів перевищує ліміт розміру.");
                if(String.IsNullOrEmpty(entry.Name)){Directory.CreateDirectory(target);continue;}
                Directory.CreateDirectory(Path.GetDirectoryName(target));using(var source=entry.Open())using(var file=new FileStream(target,FileMode.CreateNew,FileAccess.Write))source.CopyTo(file);
            }
        }
        if(!File.Exists(Path.Combine(root,"app","server.mjs"))||!File.Exists(Path.Combine(root,"runtime","node.exe")))throw new Exception("Оновлення не містить потрібних файлів.");
    }
    static bool AllowedDownload(Uri uri) {
        if(uri.Scheme!="https"||!String.IsNullOrEmpty(uri.UserInfo)||!uri.IsDefaultPort)return false;
        if(uri.Host=="api.github.com")return uri.AbsolutePath=="/repos/"+Repository+"/releases/latest";
        if(uri.Host=="github.com")return uri.AbsolutePath.StartsWith("/"+Repository+"/releases/download/",StringComparison.Ordinal);
        return uri.Host=="release-assets.githubusercontent.com"||uri.Host=="objects.githubusercontent.com"||uri.Host=="github-releases.githubusercontent.com";
    }
    static string AssetUrl(Dictionary<string,object> release,string name) {
        object value;var assets=release.TryGetValue("assets",out value)?value as System.Collections.IEnumerable:null;
        if(assets==null)return null;
        foreach(var asset in assets){var data=asset as Dictionary<string,object>;if(data!=null&&Text(data,"name")==name)return Text(data,"browser_download_url");}
        return null;
    }
    static byte[] Download(string address,long limit) {
        var uri=new Uri(address);
        for(int redirect=0;redirect<6;redirect++){
            if(!AllowedDownload(uri))throw new Exception("Адреса оновлення не належить GitHub цього проєкту.");
            var request=(HttpWebRequest)WebRequest.Create(uri);request.UserAgent="AION-Workshop-Launcher";request.Timeout=15000;request.ReadWriteTimeout=30000;request.AllowAutoRedirect=false;request.Accept="application/vnd.github+json";
            using(var response=(HttpWebResponse)request.GetResponse()) {
                if((int)response.StatusCode>=300&&(int)response.StatusCode<400){uri=new Uri(uri,response.Headers["Location"]);continue;}
                if(response.ContentLength>limit)throw new Exception("Оновлення перевищує ліміт завантаження.");
                using(var source=response.GetResponseStream())using(var output=new MemoryStream()) { byte[] buffer=new byte[65536];int read;while((read=source.Read(buffer,0,buffer.Length))>0){if(output.Length+read>limit)throw new Exception("Завантаження завелике.");output.Write(buffer,0,read);if(limit>1048576)Say("Завантажую оновлення: "+(output.Length/1048576)+" МБ…");}return output.ToArray(); }
            }
        }
        throw new Exception("Забагато переадресацій оновлення.");
    }
    static string CheckUpdate(string current,bool manual) {
        try {
            Say("Перевіряю оновлення…");
            var release=ReadObject(Encoding.UTF8.GetString(Download("https://api.github.com/repos/"+Repository+"/releases/latest",1048576)));
            string tag=Text(release,"tag_name");if(tag!=null&&tag.StartsWith("v"))tag=tag.Substring(1);
            if(!ValidVersion(tag)||new Version(tag)<=new Version(current)){if(manual)MessageBox.Show("У тебе найновіша версія.","AION Workshop");return current;}
            string manifestUrl=AssetUrl(release,"update.json"),payloadUrl=AssetUrl(release,"AION-Workshop-App.zip");
            if(manifestUrl==null||payloadUrl==null)throw new Exception("Реліз ще не містить готового оновлення.");
            var manifest=ReadObject(Encoding.UTF8.GetString(Download(manifestUrl,65536)));string hash=Text(manifest,"sha256");
            if(Text(manifest,"version")!=tag||hash==null||!Regex.IsMatch(hash,@"^[a-fA-F0-9]{64}$"))throw new Exception("Некоректний опис оновлення.");
            if(MessageBox.Show("Є версія "+tag+". Завантажити й оновити? Твої налаштування залишаться.","Оновлення AION Workshop",MessageBoxButtons.YesNo,MessageBoxIcon.Information)!=DialogResult.Yes)return current;
            if(!Complete(tag)){
                byte[] bytes=Download(payloadUrl,512L*1024*1024);using(var sha=SHA256.Create()){if(BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant()!=hash.ToLowerInvariant())throw new Exception("Контрольна сума оновлення не збігається. Стару версію збережено.");}
                string destination=VersionDirectory(tag),staging=destination+".stage-"+Guid.NewGuid().ToString("N");
                try { using(var stream=new MemoryStream(bytes))Extract(stream,staging);ValidateInstalled(staging,tag);File.WriteAllText(Path.Combine(staging,"installed.ok"),tag);if(Directory.Exists(destination))Directory.Move(destination,destination+".incomplete-"+Guid.NewGuid().ToString("N"));Directory.Move(staging,destination); }
                finally {if(Directory.Exists(staging))Directory.Delete(staging,true);}
            }
            SetCurrent(tag);return tag;
        } catch(Exception error){if(manual)MessageBox.Show("Не вдалося перевірити оновлення. "+error.Message,"AION Workshop");return current;}
    }
    static void ManualUpdate(string current) { string installed=InstalledVersion()??current,updated=CheckUpdate(installed,true);if(updated!=current)MessageBox.Show("Оновлення встановлено. Заверши роботу через значок біля годинника й запусти launcher ще раз.","AION Workshop"); }
    static void StartApp(string version) {
        Process existing;string existingUrl,existingVersion;
        if(TryExisting(out existing,out existingUrl,out existingVersion)){
            if(existingVersion==version){Child=existing;Url=existingUrl;return;}
            try{existing.Kill();existing.WaitForExit(3000);}finally{existing.Dispose();}
        }
        Say("Запускаю майстерню…");int port=SelectPort(PortFile);
        string folder=VersionDirectory(version);var info=new ProcessStartInfo(Path.Combine(folder,"runtime","node.exe"),"server.mjs"){WorkingDirectory=Path.Combine(folder,"app"),UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden};
        info.EnvironmentVariables["AION_WORKSHOP_DATA_DIR"]=Path.Combine(Root,"data");info.EnvironmentVariables["AION_WORKSHOP_PORT"]=port.ToString();Child=Process.Start(info);Url="http://127.0.0.1:"+port;
        bool ready=false;for(int attempt=0;attempt<100;attempt++) {if(Child.HasExited)break;try{var request=(HttpWebRequest)WebRequest.Create(Url+"/api/app-info");request.Timeout=250;using(var response=request.GetResponse())using(var reader=new StreamReader(response.GetResponseStream())){var data=ReadObject(reader.ReadToEnd());if(Text(data,"appId")=="aion-workshop"&&Text(data,"version")==version&&Text(data,"repositoryUrl")=="https://github.com/"+Repository){ready=true;break;}}}catch{}Thread.Sleep(100);Application.DoEvents();}
        if(!ready)throw new Exception("Програма не запустилася. Дані збережено. Спробуй ще раз.");
        File.WriteAllText(Path.Combine(Root,"running.json"),Json.Serialize(new{pid=Child.Id,url=Url,version=version}));
    }
    static bool TryExisting(out Process process,out string url,out string version) {
        process=null;url=null;version=null;
        try{
            var running=ReadObject(File.ReadAllText(Path.Combine(Root,"running.json")));version=Text(running,"version");url=Text(running,"url");if(!ValidVersion(version)||!Regex.IsMatch(url??"",@"^http://127\.0\.0\.1:\d{4,5}$"))return false;
            process=Process.GetProcessById(Convert.ToInt32(running["pid"]));
            string expected=Path.Combine(VersionDirectory(version),"runtime","node.exe");if(process.HasExited||!String.Equals(Path.GetFullPath(process.MainModule.FileName),Path.GetFullPath(expected),StringComparison.OrdinalIgnoreCase))throw new Exception();
            var request=(HttpWebRequest)WebRequest.Create(url+"/api/app-info");request.Timeout=750;
            using(var response=request.GetResponse())using(var reader=new StreamReader(response.GetResponseStream())){var data=ReadObject(reader.ReadToEnd());if(Text(data,"appId")!="aion-workshop"||Text(data,"version")!=version||Text(data,"repositoryUrl")!="https://github.com/"+Repository)throw new Exception();}
            return true;
        }catch{if(process!=null)process.Dispose();process=null;return false;}
    }
    static void OpenExisting() {Process process;string url,version;if(TryExisting(out process,out url,out version)){try{OpenBrowser(url);}finally{process.Dispose();}} }
    static void OpenBrowser(string url) {if(!NoBrowser)Process.Start(new ProcessStartInfo(url){UseShellExecute=true});}
    static void KillChild() {if(Child!=null)try{if(!Child.HasExited)Child.Kill();Child.Dispose();}catch{}finally{Child=null;} }
    static void Shutdown() {if(Exiting)return;Exiting=true;if(Tray!=null){Tray.Visible=false;Tray.Dispose();}KillChild();if(Lock!=null)try{Lock.ReleaseMutex();}catch{} }
    static int SelfTest() {
        if(!ValidVersion(EmbeddedVersion)||ValidVersion("../bad")||!AllowedDownload(new Uri("https://api.github.com/repos/"+Repository+"/releases/latest"))||AllowedDownload(new Uri("https://example.com/file.zip"))||AllowedDownload(new Uri("https://github.com/another/project/releases/download/v1/a.zip"))||AllowedDownload(new Uri("http://github.com/"+Repository+"/releases/download/v1/a.zip")))return 2;
        using(var resource=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")){if(resource==null||resource.Length<100)return 3;using(var sha=SHA256.Create())if(BitConverter.ToString(sha.ComputeHash(resource)).Replace("-","").ToLowerInvariant()!=Text(ReadObject(ResourceText("launcher.json")),"payloadSha256"))return 4;}
        var release=ReadObject("{\"tag_name\":\"v3.2.0\",\"assets\":[{\"name\":\"update.json\",\"browser_download_url\":\"https://github.com/"+Repository+"/releases/download/v3.2.0/update.json\"},{\"name\":\"AION-Workshop-App.zip\",\"browser_download_url\":\"https://github.com/"+Repository+"/releases/download/v3.2.0/AION-Workshop-App.zip\"}]}");
        if(AssetUrl(release,"update.json")!="https://github.com/"+Repository+"/releases/download/v3.2.0/update.json"||AssetUrl(release,"AION-Workshop-App.zip")==null||AssetUrl(release,"missing")!=null||AssetUrl(ReadObject("{\"assets\":[null,7,\"bad\"]}"),"update.json")!=null)return 6;
        if(!ValidPort(1024)||!ValidPort(65535)||ValidPort(1023)||ValidPort(65536))return 9;
        bool relativeRejected=false;try{ProfileRoot("relative/profile");}catch{relativeRejected=true;}if(!relativeRejected)return 14;
        if(ProfileRoot(Path.Combine(Path.GetTempPath(),"aion-profile-check"))!=Path.GetFullPath(Path.Combine(Path.GetTempPath(),"aion-profile-check")))return 15;
        string temporary=Path.Combine(Path.GetTempPath(),"aion-launcher-selftest-"+Guid.NewGuid().ToString("N"));
        try{
            using(var stream=new MemoryStream()){using(var zip=new ZipArchive(stream,ZipArchiveMode.Create,true)){using(var entry=zip.CreateEntry("../outside.txt").Open()){entry.WriteByte(1);}}stream.Position=0;bool rejected=false;try{Extract(stream,temporary);}catch{rejected=true;}if(!rejected)return 5;}
            Directory.CreateDirectory(Path.Combine(temporary,"app"));Directory.CreateDirectory(Path.Combine(temporary,"runtime"));
            File.WriteAllText(Path.Combine(temporary,"app","server.mjs"),"// fixture");File.WriteAllText(Path.Combine(temporary,"runtime","node.exe"),"fixture");
            File.WriteAllText(Path.Combine(temporary,"app","package.json"),Json.Serialize(new{version=EmbeddedVersion}));File.WriteAllText(Path.Combine(temporary,"app","release-config.json"),Json.Serialize(new{repository=Repository}));ValidateInstalled(temporary,EmbeddedVersion);
            bool mismatchRejected=false;try{ValidateInstalled(temporary,"0.0.0");}catch{mismatchRejected=true;}if(!mismatchRejected)return 7;
            File.WriteAllText(Path.Combine(temporary,"app","release-config.json"),"{\"repository\":\"another/project\"}");mismatchRejected=false;try{ValidateInstalled(temporary,EmbeddedVersion);}catch{mismatchRejected=true;}if(!mismatchRejected)return 8;
            string portFile=Path.Combine(temporary,"port.json");int first=SelectPort(portFile);if(SelectPort(portFile)!=first)return 10;
            var occupied=new TcpListener(IPAddress.Loopback,first);occupied.Start();int replacement;try{replacement=SelectPort(portFile);if(replacement==first||!ValidPort(replacement))return 11;}finally{occupied.Stop();}
            if(SelectPort(portFile)!=replacement)return 12;
            File.WriteAllText(portFile,"{\"port\":0}");if(!ValidPort(SelectPort(portFile)))return 13;
        }
        finally{if(Directory.Exists(temporary))Directory.Delete(temporary,true);}
        return 0;
    }
}
