using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

internal static class IndexedUpdate {
    static string Hash(Stream stream){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
    static long Number(Dictionary<string,object> value,string key){object found;if(!value.TryGetValue(key,out found)||!(found is int||found is long))throw new Exception("Некоректний індекс файлів.");return Convert.ToInt64(found);}
    static string SafePath(string root,string relative){
        if(relative==null||!Regex.IsMatch(relative,@"^(app|runtime)/")||relative.Length>240)throw new Exception("Небезпечний шлях оновлення.");
        foreach(string part in relative.Split('/'))if(part.Length==0||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" ")||part.IndexOfAny(Path.GetInvalidFileNameChars())>=0||Regex.IsMatch(part,@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)",RegexOptions.IgnoreCase))throw new Exception("Небезпечний шлях оновлення.");
        string prefix=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,target=Path.GetFullPath(Path.Combine(prefix,relative.Replace('/',Path.DirectorySeparatorChar)));
        if(!target.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))throw new Exception("Шлях за межами програми.");
        for(string current=target;current!=null&&current.Length>=prefix.Length;current=Path.GetDirectoryName(current))if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new Exception("Посилання у файлах програми.");
        if(Directory.Exists(root)&&(File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0)throw new Exception("Посилання у папці програми.");return target;
    }
    internal static void Apply(Dictionary<string,object> index,string current,string destination,Func<long,long,long,byte[]> download){
        if(Number(index,"format")!=1)throw new Exception("Непідтримуваний індекс.");long packageSize=Number(index,"packageSize");
        if(packageSize<1||packageSize>512L*1024*1024||Directory.Exists(destination))throw new Exception("Некоректна папка або розмір пакета.");
        object raw;if(!index.TryGetValue("files",out raw)||!(raw is IEnumerable))throw new Exception("Немає списку файлів.");
        var entries=new List<Dictionary<string,object>>();var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);long total=0;
        // Validate the entire index before writing or downloading anything.
        foreach(object item in (IEnumerable)raw){var row=item as Dictionary<string,object>;if(row==null)throw new Exception("Некоректний файл індексу.");
            string name=row.ContainsKey("path")?row["path"] as string:null,hash=row.ContainsKey("sha256")?row["sha256"] as string:null;SafePath(destination,name);SafePath(current,name);
            long size=Number(row,"size"),offset=Number(row,"offset"),compressed=Number(row,"compressed"),method=Number(row,"method");
            if(!seen.Add(name)||entries.Count>=20000||hash==null||!Regex.IsMatch(hash,@"^[a-f0-9]{64}$")||size<0||size>200L*1024*1024||(total+=size)>1024L*1024*1024||offset<0||compressed<0||compressed>200L*1024*1024||offset>packageSize-compressed||(method!=0&&method!=8))throw new Exception("Некоректний індекс файлів.");entries.Add(row);
        }
        if(!seen.Contains("app/server.mjs")||!seen.Contains("app/package.json")||!seen.Contains("app/release-config.json")||!seen.Contains("runtime/node.exe"))throw new Exception("Неповний індекс програми.");
        Directory.CreateDirectory(destination);
        foreach(var row in entries){string name=(string)row["path"],hash=(string)row["sha256"],source=SafePath(current,name),target=SafePath(destination,name);long size=Number(row,"size");Directory.CreateDirectory(Path.GetDirectoryName(target));bool reuse=false;
            if(File.Exists(source)&&new FileInfo(source).Length==size)using(var input=File.OpenRead(source))reuse=Hash(input)==hash;
            if(reuse){File.Copy(source,target,false);continue;}
            long compressed=Number(row,"compressed"),offset=Number(row,"offset");byte[] bytes=compressed==0?new byte[0]:download(offset,compressed,packageSize);
            if(bytes.LongLength!=compressed)throw new Exception("Неповне завантаження файлу.");
            using(var input=new MemoryStream(bytes))using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write)){
                Stream content=Number(row,"method")==8?(Stream)new DeflateStream(input,CompressionMode.Decompress,true):input;
                try{byte[] buffer=new byte[65536];int read;long written=0;while((read=content.Read(buffer,0,buffer.Length))>0){if((written+=read)>size)throw new Exception("Розмір файлу перевищено.");output.Write(buffer,0,read);}if(written!=size)throw new Exception("Неповний файл.");}finally{if(content!=input)content.Dispose();}
            }
            using(var file=File.OpenRead(target))if(Hash(file)!=hash)throw new Exception("Контрольна сума файлу не збігається.");
        }
    }
}
