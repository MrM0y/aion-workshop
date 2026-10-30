using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Web.Script.Serialization;
using System.Net;
internal static class RemoteIndexedSmoke {
    static int Main(string[] args){
        try{
            ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
            typeof(Launcher).GetField("Repository",BindingFlags.NonPublic|BindingFlags.Static).SetValue(null,"MrM0y/aion-workshop");
            var index=new JavaScriptSerializer{MaxJsonLength=4*1024*1024}.Deserialize<Dictionary<string,object>>(File.ReadAllText(args[0]));
            var method=typeof(Launcher).GetMethod("Download",BindingFlags.NonPublic|BindingFlags.Static);int requests=0;long bytes=0;
            IndexedUpdate.Apply(index,args[1],args[2],(offset,count,total)=>{requests++;bytes+=count;return (byte[])method.Invoke(null,new object[]{args[3],count,(long?)offset,(long?)total});});
            Console.WriteLine("Remote range update passed: "+requests+" file requests; "+bytes+" bytes downloaded instead of "+index["packageSize"]+"; unchanged files reused locally.");return 0;
        }catch(Exception error){Console.Error.WriteLine(error.GetBaseException().Message);return 1;}
    }
}
