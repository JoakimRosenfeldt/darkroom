use super::*;
use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::time::{Duration,Instant,UNIX_EPOCH};

pub(super) fn format_id(name:&str)->Option<&'static str> {
    let extension=Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "nef"=>Some("nef"),"jpg"|"jpeg"=>Some("jpeg"),"png"=>Some("png"),"webp"=>Some("webp"),
        "dng"=>Some("dng"),"cr2"=>Some("cr2"),"cr3"=>Some("cr3"),"arw"=>Some("arw"),
        "raf"=>Some("raf"),"orf"=>Some("orf"),"rw2"=>Some("rw2"),"heif"|"heic"|"hif"=>Some("heif"),
        "tif"|"tiff"=>Some("tiff"),"psd"|"psb"=>Some("psd"),"jxl"=>Some("jxl"),
        "mov"|"mp4"|"m4v"|"avi"|"mkv"=>Some("video"),_=>None,
    }
}

#[cfg(unix)]
fn local_file_id(metadata:&fs::Metadata)->Value {
    use std::os::unix::fs::MetadataExt;
    json!(format!("{}:{}",metadata.dev(),metadata.ino()))
}

#[cfg(not(unix))]
fn local_file_id(_: &fs::Metadata)->Value { Value::Null }

fn update(operations:&Arc<Mutex<HashMap<String,ScanOperation>>>,operation_id:&str,snapshot:&Value) {
    if let Ok(mut all)=operations.lock() {
        if let Some(operation)=all.get_mut(operation_id) { operation.snapshot=snapshot.clone(); }
    }
}

fn emit(callback:&Option<Arc<dyn Fn(&str,Value)+Send+Sync>>,sequence:&Arc<AtomicU64>,snapshot:&Value,kind:&str,payload:Value) {
    if let Some(callback)=callback {
        let number=sequence.fetch_add(1,Ordering::SeqCst)+1;
        callback("darkroom:catalog-event",json!({"catalogId":snapshot["catalogId"],"sessionId":snapshot["sessionId"],"operationId":snapshot["operationId"],"sequence":number,"kind":kind,"payload":payload}));
    }
}

pub(super) fn scan_folder<F:FnMut(&str,usize,usize,usize,&str)>(root:&Path,cancelled:&AtomicBool,timeout:Duration,mut progress:F)->Result<(Vec<Value>,usize,usize,String),String> {
    let started=Instant::now();
    let canonical=fs::canonicalize(root).map_err(|e|e.to_string())?;
    if canonical!=root { return Err("Scan root changed during scan.".into()) }
    let mut queue=VecDeque::new();
    queue.push_back((canonical,String::new()));
    let mut observations=Vec::new();
    let mut directories=0usize;
    let mut files=0usize;
    let mut current=String::new();
    while let Some((directory,relative))=queue.pop_front() {
        if cancelled.load(Ordering::SeqCst) { return Err("cancelled".into()) }
        if started.elapsed()>timeout { return Err("timed-out".into()) }
        let metadata=fs::symlink_metadata(&directory).map_err(|e|e.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err("Scan directory changed to a non-directory.".into()) }
        directories+=1;
        if directories>10_000 { return Err("Folder is too large or contains too many subfolders to scan.".into()) }
        current=relative.clone();
        progress("scanning",directories,files,observations.len(),&current);
        let entries=fs::read_dir(&directory).map_err(|e|e.to_string())?;
        for item in entries {
            if cancelled.load(Ordering::SeqCst) { return Err("cancelled".into()) }
            let item=item.map_err(|e|e.to_string())?;
            let name=item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') { continue }
            let path=item.path();
            let relative_path=if relative.is_empty() { name.clone() } else { format!("{relative}/{name}") };
            let metadata=fs::symlink_metadata(&path).map_err(|e|e.to_string())?;
            if metadata.file_type().is_symlink() { continue }
            if metadata.is_dir() { queue.push_back((path,relative_path)); continue }
            if !metadata.is_file() { continue }
            let Some(format_id)=format_id(&name) else { continue };
            files+=1;
            let modified=metadata.modified().ok().and_then(|at|at.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_nanos() as f64/1_000_000.0);
            observations.push(json!({"relativePath":relative_path,"observation":{"byteLength":metadata.len(),"modifiedAt":modified,"observedAt":now(),"localFileId":local_file_id(&metadata)},"health":"present","formatId":format_id,"cameraMake":null,"cameraModel":null,"lensModel":null}));
            if files%32==0 { progress("statting",directories,files,observations.len(),&current); }
        }
        progress("statting",directories,files,observations.len(),&current);
    }
    observations.sort_by(|a,b|a["relativePath"].as_str().cmp(&b["relativePath"].as_str()));
    Ok((observations,directories,files,current))
}

impl CatalogService {
    pub(super) fn cancel_all_scans(&mut self) {
        if let Ok(all)=self.operations.lock() {
            for operation in all.values() { operation.cancelled.store(true,Ordering::SeqCst); }
        }
        if let Ok(all)=self.fingerprint_jobs.lock() {
            for operation in all.values() { operation.cancelled.store(true,Ordering::SeqCst); }
        }
        for handle in self.scan_handles.drain(..) {let _=handle.join();}
    }

    pub(super) fn start_scan(&mut self,input:&Value)->Result<Value,String> {
        self.require_session(input)?;
        let catalog_id=string(input,"catalogId")?.to_string();
        let session_id=string(input,"sessionId")?.to_string();
        let root_id=string(input,"rootId")?.to_string();
        let root=one(self.db()?,"SELECT canonical_path AS canonicalPath,health FROM roots WHERE catalog_id=? AND root_id=?",values(&[&json!(catalog_id),&json!(root_id)]))?.ok_or("Scan root is missing.")?;
        if root["health"]!="online" { return Err("Scan root is offline.".into()) }
        let root_path=PathBuf::from(string(&root,"canonicalPath")?);
        let operation_id=Uuid::new_v4().to_string();
        let snapshot=json!({"operationId":operation_id,"catalogId":catalog_id,"sessionId":session_id,"status":"running","directoriesVisited":0,"filesConsidered":0,"acceptedCount":0,"currentPath":null});
        let cancelled=Arc::new(AtomicBool::new(false));
        self.operations.lock().map_err(|e|e.to_string())?.insert(operation_id.clone(),ScanOperation{snapshot:snapshot.clone(),cancelled:cancelled.clone()});
        let operations=self.operations.clone();
        let callback=self.emit.clone();
        let sequence=self.event_sequence.clone();
        let database_path=self.active_path().ok_or("No catalog is open.")?.to_path_buf();
        let timeout=Duration::from_millis(input.get("timeoutMs").and_then(Value::as_u64).unwrap_or(24*60*60*1000));
        let handle=json!({"operationId":operation_id,"catalogId":catalog_id,"sessionId":session_id,"status":"running"});
        let worker=std::thread::spawn(move || {
            let mut progress_snapshot=snapshot;
            let result=scan_folder(&root_path,&cancelled,timeout,|phase,directories,files,accepted,current| {
                progress_snapshot["directoriesVisited"]=json!(directories);
                progress_snapshot["filesConsidered"]=json!(files);
                progress_snapshot["acceptedCount"]=json!(accepted);
                progress_snapshot["currentPath"]=json!(current);
                update(&operations,&operation_id,&progress_snapshot);
                emit(&callback,&sequence,&progress_snapshot,"scan-progress",json!({"phase":phase,"directoriesVisited":directories,"filesConsidered":files,"acceptedCount":accepted,"currentPath":current}));
            });
            let outcome=(||->Result<(),String>{
                let (observations,directories,files,current)=result?;
                if cancelled.load(Ordering::SeqCst) { return Err("cancelled".into()) }
                let db=Connection::open(database_path).map_err(|e|e.to_string())?;
                db.pragma_update(None,"foreign_keys","ON").map_err(|e|e.to_string())?;
                let mut service=CatalogService::for_worker(db);
                let revision=service.revision(&catalog_id)?;
                let accepted=observations.len();
                service.apply(&json!({"catalogId":catalog_id,"expectedRevision":revision,"mutations":[{"kind":"reconcile-complete","rootId":root_id,"observations":observations}]}))?;
                progress_snapshot["directoriesVisited"]=json!(directories);
                progress_snapshot["filesConsidered"]=json!(files);
                progress_snapshot["acceptedCount"]=json!(accepted);
                progress_snapshot["currentPath"]=json!(current);
                Ok(())
            })();
            let status=match &outcome { Ok(())=>"completed",Err(error) if error=="cancelled"=>"cancelled",Err(error) if error=="timed-out"=>"timed-out",Err(_)=>"failed" };
            progress_snapshot["status"]=json!(status);
            if let Err(error)=&outcome { if status=="failed" { progress_snapshot["errorMessage"]=json!(error); } }
            update(&operations,&operation_id,&progress_snapshot);
            let mut payload=json!({"status":status,"directoriesVisited":progress_snapshot["directoriesVisited"],"filesConsidered":progress_snapshot["filesConsidered"],"acceptedCount":progress_snapshot["acceptedCount"],"currentPath":progress_snapshot["currentPath"]});
            if status=="failed" { payload["errorMessage"]=progress_snapshot["errorMessage"].clone(); }
            emit(&callback,&sequence,&progress_snapshot,"scan-terminal",payload);
        });
        self.scan_handles.push(worker);
        Ok(handle)
    }

    pub(super) fn cancel_scan(&self,input:&Value)->Result<Value,String> {
        self.require_session(input)?;
        let operation_id=string(input,"operationId")?;
        let all=self.operations.lock().map_err(|e|e.to_string())?;
        let operation=all.get(operation_id).ok_or("Scan operation is missing.")?;
        operation.cancelled.store(true,Ordering::SeqCst);
        Ok(Value::Null)
    }

    pub(super) fn scan_operation(&self,input:&Value,wait:bool)->Result<Value,String> {
        self.require_session(input)?;
        let operation_id=string(input,"operationId")?;
        loop {
            let snapshot={
                let all=self.operations.lock().map_err(|e|e.to_string())?;
                all.get(operation_id).ok_or("Scan operation is missing.")?.snapshot.clone()
            };
            if !wait || snapshot["status"]!="running" { return Ok(snapshot) }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
