using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
internal static class IndexedUpdateTests {
    static string Hash(byte[] bytes){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
    static Dictionary<string,object> Row(string name,string text,int offset){byte[] bytes=Encoding.UTF8.GetBytes(text);return new Dictionary<string,object>{{"path",name},{"offset",offset},{"compressed",bytes.Length},{"size",bytes.Length},{"method",0},{"sha256",Hash(bytes)}};}
    static int Main(){string root=Path.Combine(Path.GetTempPath(),"aion-index-test-"+Guid.NewGuid().ToString("N")),current=Path.Combine(root,"current");Directory.CreateDirectory(current);try{
        var rows=new List<Dictionary<string,object>>{Row("app/server.mjs","new",0),Row("app/package.json","package",3),Row("app/release-config.json","config",10),Row("runtime/node.exe","runtime",16)};
        foreach(var row in rows){string file=Path.Combine(current,((string)row["path"]).Replace('/',Path.DirectorySeparatorChar));Directory.CreateDirectory(Path.GetDirectoryName(file));File.WriteAllText(file,(string)row["path"]=="app/server.mjs"?"old":(string)row["path"]=="app/package.json"?"package":(string)row["path"]=="runtime/node.exe"?"runtime":"config",new UTF8Encoding(false));}
        var index=new Dictionary<string,object>{{"format",1},{"packageSize",23},{"files",rows}};int downloads=0;
        IndexedUpdate.Apply(index,current,Path.Combine(root,"next"),(offset,count,total)=>{downloads++;if(offset!=0||count!=3||total!=23)throw new Exception("Wrong range");return Encoding.UTF8.GetBytes("new");});
        if(downloads!=1||File.ReadAllText(Path.Combine(root,"next/app/server.mjs"))!="new"||File.ReadAllText(Path.Combine(current,"app/server.mjs"))!="old")return 1;
        bool rejected=false;try{IndexedUpdate.Apply(index,current,Path.Combine(root,"bad-hash"),(a,b,c)=>Encoding.UTF8.GetBytes("bad"));}catch{rejected=true;}if(!rejected)return 2;
        rows.Add(Row("app/../outside","bad",0));rejected=false;try{IndexedUpdate.Apply(index,current,Path.Combine(root,"bad-path"),(a,b,c)=>{throw new Exception("Must not download");});}catch{rejected=true;}if(!rejected||Directory.Exists(Path.Combine(root,"bad-path")))return 3;rows.RemoveAt(rows.Count-1);
        rows.Add(Row("APP/server.mjs","bad",0));rejected=false;try{IndexedUpdate.Apply(index,current,Path.Combine(root,"bad-case"),(a,b,c)=>new byte[0]);}catch{rejected=true;}if(!rejected)return 4;rows.RemoveAt(rows.Count-1);
        rows[0]["size"]=-1;rejected=false;try{IndexedUpdate.Apply(index,current,Path.Combine(root,"bad-size"),(a,b,c)=>new byte[0]);}catch{rejected=true;}if(!rejected)return 5;
        Console.WriteLine("Indexed update passed: only changed bytes, preserved base, hash mismatch, traversal, duplicate and invalid-size rejection.");return 0;
    }finally{Directory.Delete(root,true);}}
}
