use super::*;
use sha2::{Digest,Sha256};

const HISTORY_SCHEMA:&str=include_str!("develop_history_schema.sql");

fn digest(raw:&str)->String { format!("{:x}",Sha256::digest(raw.as_bytes())) }

fn uuid<'a>(value:&'a Value,key:&str)->Result<&'a str,String>{
    let raw=string(value,key)?;
    let parsed=Uuid::parse_str(raw).map_err(|_|format!("Develop history {key} must be a UUID."))?;
    if parsed.to_string()!=raw || !(1..=8).contains(&parsed.get_version_num()) || parsed.get_variant()!=uuid::Variant::RFC4122 {return Err(format!("Develop history {key} must be a canonical UUID."))}
    Ok(raw)
}

fn active_entry(db:&Connection,catalog_id:&str,entry_id:&str)->Result<(),String>{
    if one(db,"SELECT 1 FROM edit_entries WHERE catalog_id=? AND entry_id=? AND tombstoned_at IS NULL",values(&[&json!(catalog_id),&json!(entry_id)]))?.is_none(){return Err("Develop history entry is inactive or missing.".into())}
    Ok(())
}

pub(crate) fn js_stringify(value:&Value)->String {
    match value {
        Value::Null=>"null".into(),
        Value::Bool(value)=>if *value {"true"} else {"false"}.into(),
        Value::Number(value)=>{
            let number=value.as_f64().unwrap_or(0.0);
            if number==0.0 { "0".into() } else { ryu_js::Buffer::new().format(number).to_string() }
        }
        Value::String(value)=>serde_json::to_string(value).unwrap_or_default(),
        Value::Array(values)=>format!("[{}]",values.iter().map(js_stringify).collect::<Vec<_>>().join(",")),
        Value::Object(values)=>{
            let mut indexed=Vec::new(); let mut other=Vec::new();
            for (key,value) in values {
                let index=key.parse::<u32>().ok().filter(|index|*index!=u32::MAX && index.to_string()==*key);
                if let Some(index)=index { indexed.push((index,key,value)); } else { other.push((key,value)); }
            }
            indexed.sort_by_key(|item|item.0);
            let pairs=indexed.into_iter().map(|(_,key,value)|(key,value)).chain(other);
            format!("{{{}}}",pairs.map(|(key,value)|format!("{}:{}",serde_json::to_string(key).unwrap_or_default(),js_stringify(value))).collect::<Vec<_>>().join(","))
        }
    }
}

fn canonical_value(value:&Value)->Value {
    match value {
        Value::Array(items)=>Value::Array(items.iter().map(canonical_value).collect()),
        Value::Object(items)=>{
            let mut keys=items.keys().collect::<Vec<_>>();keys.sort_by(|left,right|left.encode_utf16().cmp(right.encode_utf16()));
            let mut result=Map::new();
            for key in keys { result.insert(key.clone(),canonical_value(&items[key])); }
            Value::Object(result)
        },
        _=>value.clone(),
    }
}

pub(crate) fn canonical_json(value:&Value)->String { js_stringify(&canonical_value(value)) }

fn validate_json(value:&Value,depth:usize,nodes:&mut usize)->Result<(),String> {
    if depth>16 { return Err("Develop history JSON exceeds the depth limit.".into()) }
    *nodes+=1;
    if *nodes>250_000 { return Err("Develop history JSON exceeds the node limit.".into()) }
    match value {
        Value::Array(items)=>{for item in items {validate_json(item,depth+1,nodes)?;}},
        Value::Object(items)=>{for (key,item) in items {if key.contains('\0'){return Err("Develop history JSON key is invalid.".into())}validate_json(item,depth+1,nodes)?;}},
        _=>(),
    }
    Ok(())
}

fn validate_document(value:&Value)->Result<(),String> {
    if !value.is_null() && !value.is_object(){return Err("Develop document is invalid.".into())}
    validate_json(value,0,&mut 0)?;
    if canonical_json(value).len()>32*1024*1024 {return Err("Develop history document exceeds the byte limit.".into())}
    if let Some(version)=value.get("version") {
        if version==2 {
            for key in ["settings","maskAssets"] {if !value[key].is_object(){return Err(format!("Develop document {key} is invalid."))}}
        } else if version==3 {
            if value["process"]!="darkroom-v3" || !value["schemaRevision"].is_string() {return Err("Develop V3 document identity is invalid.".into())}
            for key in ["tone","color","optics","geometry","local","cleanup","presence","detail","effects","hdr","compatibility"] {if !value[key].is_object(){return Err(format!("Develop V3 {key} is invalid."))}}
        } else if version.as_f64().is_some_and(|v|v>3.0) {return Err("Newer Develop documents are read-only.".into())}
        else {return Err("Develop document version is invalid.".into())}
    }
    Ok(())
}

fn asset_hashes(document:&Value)->Vec<String> {
    if document["version"]!=3 { return Vec::new() }
    fn visit(value:&Value,result:&mut std::collections::HashSet<String>) {
        match value {
            Value::Array(items)=>{for item in items{visit(item,result)}},
            Value::Object(items)=>{
                if let (Some(id),Some(sha))=(items.get("assetId").and_then(Value::as_str),items.get("sha256").and_then(Value::as_str)) {
                    if id==sha && id.len()==64 && id.bytes().all(|b|b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {result.insert(id.into());}
                }
                for item in items.values(){visit(item,result)}
            },_=>(),
        }
    }
    let mut hashes=std::collections::HashSet::new();visit(document,&mut hashes);
    let mut result=hashes.into_iter().collect::<Vec<_>>();result.sort();result
}

fn diff(before:&Value,after:&Value)->Result<Value,String> {
    fn visit(before:&Value,after:&Value,path:&[String],operations:&mut Vec<Value>)->Result<(),String> {
        if canonical_json(before)==canonical_json(after){return Ok(())}
        if path.len()>=16 || !before.is_object() || !after.is_object() {
            operations.push(json!({"kind":"set","path":path,"value":canonical_value(after)}));return Ok(())
        }
        let old=before.as_object().ok_or("Develop history diff is invalid.")?;
        let new=after.as_object().ok_or("Develop history diff is invalid.")?;
        let mut old_keys=old.keys().collect::<Vec<_>>();old_keys.sort_by(|left,right|left.encode_utf16().cmp(right.encode_utf16()));
        for key in old_keys {if !new.contains_key(key){let mut next=path.to_vec();next.push(key.clone());operations.push(json!({"kind":"remove","path":next}));}}
        let mut new_keys=new.keys().collect::<Vec<_>>();new_keys.sort_by(|left,right|left.encode_utf16().cmp(right.encode_utf16()));
        for key in new_keys {
            let mut next=path.to_vec();next.push(key.clone());
            if let Some(previous)=old.get(key){visit(previous,&new[key],&next,operations)?}
            else {operations.push(json!({"kind":"set","path":next,"value":canonical_value(&new[key])}));}
            if operations.len()>100_000{return Err("Develop history patch exceeds the operation limit.".into())}
        }
        Ok(())
    }
    let mut operations=Vec::new();visit(before,after,&[],&mut operations)?;
    let patch=json!({"version":1,"operations":operations});
    if canonical_json(&patch).len()>2*1024*1024{return Err("Develop history patch exceeds the byte limit.".into())}
    Ok(patch)
}

pub(super) fn install(db:&Connection)->Result<(),String> {
    db.execute_batch(HISTORY_SCHEMA).map_err(|e|e.to_string())?;
    for (table,column,sql) in [
        ("develop_history_revisions","request_sha256","ALTER TABLE develop_history_revisions ADD COLUMN request_sha256 TEXT"),
        ("develop_history_revisions","assets_indexed","ALTER TABLE develop_history_revisions ADD COLUMN assets_indexed INTEGER NOT NULL DEFAULT 0"),
        ("develop_history_heads","retention_floor_ordinal","ALTER TABLE develop_history_heads ADD COLUMN retention_floor_ordinal INTEGER NOT NULL DEFAULT 0"),
    ] {
        let exists=rows(db,&format!("PRAGMA table_info({table})"),vec![])?.iter().any(|v|v["name"]==column);
        if !exists { db.execute_batch(sql).map_err(|e|e.to_string())?; }
    }
    Ok(())
}

pub(super) fn ensure_roots(db:&Connection,catalog_id:&str)->Result<(),String> {
    db.execute_batch("BEGIN IMMEDIATE").map_err(|e|e.to_string())?;
    let result=ensure_roots_inner(db,catalog_id);
    match result {Ok(())=>db.execute_batch("COMMIT").map_err(|e|e.to_string()),Err(error)=>{let _=db.execute_batch("ROLLBACK");Err(error)}}
}

pub(super) fn ensure_roots_inner(db:&Connection,catalog_id:&str)->Result<(),String> {
    let missing=rows(db,"SELECT e.catalog_id AS catalogId,e.entry_id AS entryId,m.develop_json AS developJson,COALESCE(m.develop_updated_at,e.created_at) AS createdAt FROM edit_entries e JOIN entry_metadata m ON m.catalog_id=e.catalog_id AND m.entry_id=e.entry_id LEFT JOIN develop_history_heads h ON h.catalog_id=e.catalog_id AND h.entry_id=e.entry_id WHERE e.catalog_id=? AND h.entry_id IS NULL ORDER BY e.entry_id",vec![SqlValue::Text(catalog_id.into())])?;
    for entry in missing {
        let document=if entry["developJson"].is_null() { Value::Null } else { required_document(&entry["developJson"])? };
        validate_document(&document)?;
        let checkpoint=canonical_json(&document);
        if checkpoint.len()>64*1024*1024 { return Err("Develop history entry metadata limit exceeded.".into()) }
        let used=one(db,"SELECT COALESCE(SUM(COALESCE(length(CAST(checkpoint_json AS BLOB)),0)+COALESCE(length(CAST(patch_json AS BLOB)),0)),0) AS bytes FROM develop_history_revisions WHERE catalog_id=?",values(&[&entry["catalogId"]]))?.ok_or("Develop history catalog size is missing.")?;
        if number(&used,"bytes")? as usize+checkpoint.len()>1024*1024*1024{return Err("Develop history catalog metadata limit exceeded.".into())}
        let revision_id=Uuid::new_v4().to_string();
        let operation_id=Uuid::new_v4().to_string();
        let request=js_stringify(&json!({"kind":"root","revisionId":revision_id,"document":canonical_value(&document),"createdAt":entry["createdAt"]}));
        execute(db,"INSERT INTO develop_history_revisions (catalog_id,entry_id,revision_id,parent_revision_id,operation_id,ordinal,label,request_sha256,assets_indexed,document_sha256,checkpoint_json,patch_json,created_at) VALUES (?,?,?,NULL,?,0,'Imported current edit',?,1,?,?,NULL,?)",values(&[&entry["catalogId"],&entry["entryId"],&json!(revision_id),&json!(operation_id),&json!(digest(&request)),&json!(digest(&checkpoint)),&json!(checkpoint),&entry["createdAt"]]))?;
        execute(db,"INSERT INTO develop_history_heads (catalog_id,entry_id,revision_id,updated_at,retention_floor_ordinal) VALUES (?,?,?,?,0)",values(&[&entry["catalogId"],&entry["entryId"],&json!(revision_id),&entry["createdAt"]]))?;
        for hash in asset_hashes(&document) {execute(db,"INSERT INTO develop_revision_assets (catalog_id,entry_id,revision_id,asset_sha256) VALUES (?,?,?,?)",values(&[&entry["catalogId"],&entry["entryId"],&json!(revision_id),&json!(hash)]))?;}
    }
    Ok(())
}

pub(super) fn backfill_asset_refs(db:&Connection,catalog_id:&str)->Result<(),String> {
    db.execute_batch("BEGIN IMMEDIATE").map_err(|e|e.to_string())?;
    let result=backfill_asset_refs_inner(db,catalog_id);
    match result {Ok(())=>db.execute_batch("COMMIT").map_err(|e|e.to_string()),Err(error)=>{let _=db.execute_batch("ROLLBACK");Err(error)}}
}

fn backfill_asset_refs_inner(db:&Connection,catalog_id:&str)->Result<(),String> {
    let pending=rows(db,"SELECT entry_id AS entryId,revision_id AS revisionId FROM develop_history_revisions WHERE catalog_id=? AND assets_indexed=0 ORDER BY entry_id,ordinal",vec![SqlValue::Text(catalog_id.into())])?;
    for item in pending {
        let entry_id=string(&item,"entryId")?;let revision_id=string(&item,"revisionId")?;
        let Ok(document)=reconstruct(db,catalog_id,entry_id,revision_id) else { continue };
        for hash in asset_hashes(&document){execute(db,"INSERT OR IGNORE INTO develop_revision_assets (catalog_id,entry_id,revision_id,asset_sha256) VALUES (?,?,?,?)",values(&[&json!(catalog_id),&json!(entry_id),&json!(revision_id),&json!(hash)]))?;}
        execute(db,"UPDATE develop_history_revisions SET assets_indexed=1 WHERE catalog_id=? AND entry_id=? AND revision_id=? AND assets_indexed=0",values(&[&json!(catalog_id),&json!(entry_id),&json!(revision_id)]))?;
    }
    Ok(())
}

fn required_document(raw:&Value)->Result<Value,String> {
    let text=raw.as_str().ok_or("Develop document is invalid.")?;
    let document:Value=serde_json::from_str(text).map_err(|e|e.to_string())?;
    validate_document(&document)?;
    Ok(document)
}

fn revision(db:&Connection,catalog_id:&str,entry_id:&str,revision_id:&str)->Result<Value,String> {
    one(db,"SELECT catalog_id AS catalogId,entry_id AS entryId,revision_id AS revisionId,parent_revision_id AS parentRevisionId,operation_id AS operationId,ordinal,label,document_sha256 AS documentHash,checkpoint_json AS checkpointJson,patch_json AS patchJson,created_at AS createdAt FROM develop_history_revisions WHERE catalog_id=? AND entry_id=? AND revision_id=?",values(&[&json!(catalog_id),&json!(entry_id),&json!(revision_id)]))?.ok_or("Develop history revision is missing.".into())
}

fn public_revision(row:&Value)->Value {
    json!({"catalogId":row["catalogId"],"entryId":row["entryId"],"revisionId":row["revisionId"],"parentRevisionId":row["parentRevisionId"],"operationId":row["operationId"],"ordinal":row["ordinal"],"label":row["label"],"documentHash":row["documentHash"],"checkpoint":!row["checkpointJson"].is_null(),"createdAt":row["createdAt"]})
}

fn patch_document(document:&mut Value,patch:&Value)->Result<(),String> {
    if patch["version"]!=1 || canonical_json(patch).len()>2*1024*1024 {return Err("Develop history patch is invalid.".into())}
    let operations=patch["operations"].as_array().ok_or("Develop history patch is invalid.")?;
    if operations.len()>100_000{return Err("Develop history patch exceeds the operation limit.".into())}
    for operation in operations {
        let path=operation["path"].as_array().ok_or("Develop history patch path is invalid.")?;
        if path.len()>16 || path.iter().any(|v|v.as_str().is_none_or(|s|s.contains('\0'))) {return Err("Develop history patch path is invalid.".into())}
        let mut cursor=&mut *document;
        if path.is_empty() {
            if operation["kind"]=="set" { *cursor=operation["value"].clone(); } else { return Err("Develop history patch root removal is invalid.".into()) }
            continue;
        }
        for part in &path[..path.len()-1] {
            let key=part.as_str().ok_or("Develop history patch path is invalid.")?;
            cursor=cursor.get_mut(key).ok_or("Develop history patch target is missing.")?;
        }
        let key=path.last().and_then(Value::as_str).ok_or("Develop history patch path is invalid.")?;
        let object=cursor.as_object_mut().ok_or("Develop history patch target is invalid.")?;
        if operation["kind"]=="set" { object.insert(key.into(),operation["value"].clone()); }
        else if operation["kind"]=="remove" { object.remove(key); }
        else { return Err("Develop history patch operation is invalid.".into()) }
    }
    Ok(())
}

struct ReconstructionFailure { kind:&'static str, message:String, failed:String, last_valid:Option<String> }

fn try_reconstruct(db:&Connection,catalog_id:&str,entry_id:&str,revision_id:&str)->Result<Value,ReconstructionFailure> {
    let mut chain=Vec::new();
    let mut current=revision_id.to_string();
    let mut seen=std::collections::HashSet::new();
    loop {
        if !seen.insert(current.clone()) { return Err(ReconstructionFailure{kind:"cycle",message:"Develop history contains a revision cycle.".into(),failed:current,last_valid:None}) }
        let row=revision(db,catalog_id,entry_id,&current).map_err(|_|ReconstructionFailure{kind:"missing-revision",message:"Develop history revision is missing.".into(),failed:current.clone(),last_valid:None})?;
        let parent=row["parentRevisionId"].as_str().map(str::to_string);
        let checkpoint=!row["checkpointJson"].is_null();
        chain.push(row);
        if checkpoint { break }
        if chain.len()>20 { return Err(ReconstructionFailure{kind:"checkpoint",message:"Develop history checkpoint chain is invalid.".into(),failed:current,last_valid:None}) }
        current=parent.ok_or_else(||ReconstructionFailure{kind:"checkpoint",message:"Develop history checkpoint chain is invalid.".into(),failed:current,last_valid:None})?;
    }
    chain.reverse();
    let checkpoint_id=chain[0]["revisionId"].as_str().unwrap_or(revision_id).to_string();
    let mut document=required_document(&chain[0]["checkpointJson"]).map_err(|error|ReconstructionFailure{kind:"document",message:error,failed:checkpoint_id.clone(),last_valid:None})?;
    if digest(&canonical_json(&document))!=chain[0]["documentHash"] { return Err(ReconstructionFailure{kind:"hash",message:"Develop history checkpoint hash is corrupt.".into(),failed:checkpoint_id,last_valid:None}) }
    let mut last_valid=chain[0]["revisionId"].as_str().map(str::to_string);
    for row in chain.iter().skip(1) {
        let id=row["revisionId"].as_str().unwrap_or(revision_id).to_string();
        let patched=(||->Result<(),String>{
            let patch:Value=serde_json::from_str(row["patchJson"].as_str().ok_or("Develop history patch is missing.")?).map_err(|e|e.to_string())?;
            patch_document(&mut document,&patch)?;
            validate_document(&document)
        })();
        if let Err(error)=patched{return Err(ReconstructionFailure{kind:"patch",message:error,failed:id,last_valid})}
        if digest(&canonical_json(&document))!=row["documentHash"] { return Err(ReconstructionFailure{kind:"hash",message:"Develop history revision hash is corrupt.".into(),failed:id,last_valid}) }
        last_valid=Some(id);
    }
    Ok(document)
}

pub(crate) fn reconstruct(db:&Connection,catalog_id:&str,entry_id:&str,revision_id:&str)->Result<Value,String> {
    try_reconstruct(db,catalog_id,entry_id,revision_id).map_err(|failure|failure.message)
}

pub(crate) fn head(db:&Connection,catalog_id:&str,entry_id:&str)->Result<String,String> {
    let value=one(db,"SELECT revision_id AS revisionId FROM develop_history_heads WHERE catalog_id=? AND entry_id=?",values(&[&json!(catalog_id),&json!(entry_id)]))?.ok_or("Develop history Head is missing.")?;
    Ok(string(&value,"revisionId")?.to_string())
}

fn recovery_revision(db:&Connection,catalog_id:&str,entry_id:&str,revision_id:&str)->Option<Value> {
    let document=reconstruct(db,catalog_id,entry_id,revision_id).ok()?;
    let row=revision(db,catalog_id,entry_id,revision_id).ok()?;
    let mut result=public_revision(&row);result["document"]=document;Some(result)
}

fn latest_valid(db:&Connection,catalog_id:&str,entry_id:&str)->Result<Value,String> {
    let rows=rows(db,"SELECT revision_id AS revisionId FROM develop_history_revisions WHERE catalog_id=? AND entry_id=? ORDER BY ordinal DESC",values(&[&json!(catalog_id),&json!(entry_id)]))?;
    for row in rows {if let Some(revision_id)=row["revisionId"].as_str(){if let Some(recovered)=recovery_revision(db,catalog_id,entry_id,revision_id){return Ok(recovered)}}}
    Ok(Value::Null)
}

pub(crate) fn loaded(db:&Connection,catalog_id:&str,entry_id:&str,revision_id:Option<&str>)->Result<Value,String> {
    active_entry(db,catalog_id,entry_id)?;
    let head_id=match head(db,catalog_id,entry_id) {
        Ok(id)=>id,
        Err(_)=>return Ok(json!({"kind":"recovery","catalogId":catalog_id,"entryId":entry_id,"requestedRevisionId":revision_id,"headRevisionId":null,"lastValidRevision":latest_valid(db,catalog_id,entry_id)?,"corruption":{"kind":"missing-head","message":"Develop history Head is missing.","failedRevisionId":null}})),
    };
    let requested=revision_id.unwrap_or(&head_id);
    if revision_id.is_some_and(|id|id!=head_id) && one(db,"SELECT 1 FROM develop_history_revisions r JOIN develop_history_heads h ON h.catalog_id=r.catalog_id AND h.entry_id=r.entry_id WHERE r.catalog_id=? AND r.entry_id=? AND r.revision_id=? AND (r.ordinal>=h.retention_floor_ordinal OR EXISTS (SELECT 1 FROM develop_history_refs f WHERE f.catalog_id=r.catalog_id AND f.entry_id=r.entry_id AND f.revision_id=r.revision_id))",values(&[&json!(catalog_id),&json!(entry_id),&json!(requested)]))?.is_none(){return Err("Develop history revision is outside the retained history window.".into())}
    let document=match try_reconstruct(db,catalog_id,entry_id,requested) {
        Ok(document)=>document,
        Err(failure)=>{
            let last_valid=if let Some(id)=failure.last_valid.as_deref(){recovery_revision(db,catalog_id,entry_id,id).unwrap_or(Value::Null)}else{latest_valid(db,catalog_id,entry_id)?};
            return Ok(json!({"kind":"recovery","catalogId":catalog_id,"entryId":entry_id,"requestedRevisionId":revision_id,"headRevisionId":head_id,"lastValidRevision":last_valid,"corruption":{"kind":failure.kind,"message":failure.message,"failedRevisionId":failure.failed}}))
        },
    };
    let row=revision(db,catalog_id,entry_id,requested)?;
    let mut value=public_revision(&row);
    value["document"]=document;
    value["headRevisionId"]=json!(head_id);
    Ok(json!({"kind":"loaded","value":value}))
}

pub(crate) fn commit(db:&Connection,input:&Value)->Result<Value,String> {
    let catalog_id=uuid(input,"catalogId")?;
    let entry_id=uuid(input,"entryId")?;
    let revision_id=uuid(input,"revisionId")?;
    let expected=uuid(input,"expectedParentRevisionId")?;
    let operation_id=uuid(input,"operationId")?;
    active_entry(db,catalog_id,entry_id)?;
    let label=string(input,"label")?;
    if label.trim().is_empty() || label.len()>120 || label!=label.trim(){return Err("Develop history label is invalid.".into())}
    let document=field(input,"document")?;
    if !document.is_null() && !document.is_object() { return Err("Develop document is invalid.".into()) }
    let created_at=field(input,"createdAt")?;
    if !created_at.as_f64().is_some_and(f64::is_finite) { return Err("Develop history createdAt is invalid.".into()) }
    validate_document(document)?;
    let serialized=canonical_json(document);
    let request=canonical_json(&json!({"revisionId":revision_id,"expectedParentRevisionId":expected,"operationId":operation_id,"label":label,"document":document,"createdAt":created_at}));
    let request_hash=digest(&request);
    let existing=one(db,"SELECT catalog_id AS catalogId,entry_id AS entryId,revision_id AS revisionId,parent_revision_id AS parentRevisionId,operation_id AS operationId,ordinal,label,document_sha256 AS documentHash,checkpoint_json AS checkpointJson,request_sha256 AS requestHash,created_at AS createdAt FROM develop_history_revisions WHERE catalog_id=? AND entry_id=? AND operation_id=?",values(&[&json!(catalog_id),&json!(entry_id),&json!(operation_id)]))?;
    if let Some(existing)=existing {
        let existing_hash=if let Some(hash)=existing["requestHash"].as_str(){hash.to_string()}else{
            let old_document=reconstruct(db,catalog_id,entry_id,string(&existing,"revisionId")?)?;
            let old_request=canonical_json(&json!({"revisionId":existing["revisionId"],"expectedParentRevisionId":existing["parentRevisionId"],"operationId":existing["operationId"],"label":existing["label"],"document":old_document,"createdAt":existing["createdAt"]}));
            let hash=digest(&old_request);
            execute(db,"UPDATE develop_history_revisions SET request_sha256=? WHERE catalog_id=? AND entry_id=? AND revision_id=? AND request_sha256 IS NULL",values(&[&json!(hash),&json!(catalog_id),&json!(entry_id),&existing["revisionId"]]))?;
            hash
        };
        if existing_hash!=request_hash { return Err("Develop history operation ID conflicts with a different request.".into()) }
        return Ok(json!({"revision":public_revision(&existing),"idempotent":true}))
    }
    let head_id=head(db,catalog_id,entry_id)?;
    if head_id!=expected { return Err("Develop history parent is stale.".into()) }
    if one(db,"SELECT 1 FROM develop_history_revisions WHERE catalog_id=? AND entry_id=? AND revision_id=?",values(&[&json!(catalog_id),&json!(entry_id),&json!(revision_id)]))?.is_some() { return Err("Develop history revision ID already exists.".into()) }
    let parent=revision(db,catalog_id,entry_id,expected)?;
    let ordinal=number(&parent,"ordinal")?+1;
    let before=reconstruct(db,catalog_id,entry_id,expected)?;
    let patch=diff(&before,document)?;
    let patch_json=canonical_json(&patch);
    let accumulated=one(db,"SELECT COALESCE(SUM(length(CAST(patch_json AS BLOB))),0) AS bytes FROM develop_history_revisions WHERE catalog_id=? AND entry_id=? AND ordinal>COALESCE((SELECT MAX(ordinal) FROM develop_history_revisions WHERE catalog_id=? AND entry_id=? AND checkpoint_json IS NOT NULL),0)",values(&[&json!(catalog_id),&json!(entry_id),&json!(catalog_id),&json!(entry_id)]))?.ok_or("Develop history patch size is missing.")?;
    let checkpoint=ordinal%20==0 || number(&accumulated,"bytes")? as usize+patch_json.len()>=256*1024;
    let stored=if checkpoint{&serialized}else{&patch_json};
    let bytes=one(db,"SELECT COALESCE(SUM(COALESCE(length(CAST(checkpoint_json AS BLOB)),0)+COALESCE(length(CAST(patch_json AS BLOB)),0)),0) AS bytes FROM develop_history_revisions WHERE catalog_id=? AND entry_id=?",values(&[&json!(catalog_id),&json!(entry_id)]))?.unwrap_or(json!({"bytes":0}));
    if number(&bytes,"bytes")? as usize + stored.len()>64*1024*1024 { return Err("Develop history entry metadata limit exceeded.".into()) }
    let catalog_bytes=one(db,"SELECT COALESCE(SUM(COALESCE(length(CAST(checkpoint_json AS BLOB)),0)+COALESCE(length(CAST(patch_json AS BLOB)),0)),0) AS bytes FROM develop_history_revisions WHERE catalog_id=?",values(&[&json!(catalog_id)]))?.ok_or("Develop history catalog size is missing.")?;
    if number(&catalog_bytes,"bytes")? as usize+stored.len()>1024*1024*1024{return Err("Develop history catalog metadata limit exceeded.".into())}
    let checkpoint_value=if checkpoint{json!(stored)}else{Value::Null};
    let patch_value=if checkpoint{Value::Null}else{json!(stored)};
    execute(db,"INSERT INTO develop_history_revisions (catalog_id,entry_id,revision_id,parent_revision_id,operation_id,ordinal,label,request_sha256,assets_indexed,document_sha256,checkpoint_json,patch_json,created_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)",values(&[&json!(catalog_id),&json!(entry_id),&json!(revision_id),&json!(expected),&json!(operation_id),&json!(ordinal),&json!(label),&json!(request_hash),&json!(digest(&serialized)),&checkpoint_value,&patch_value,created_at]))?;
    for hash in asset_hashes(document){execute(db,"INSERT INTO develop_revision_assets (catalog_id,entry_id,revision_id,asset_sha256) VALUES (?,?,?,?)",values(&[&json!(catalog_id),&json!(entry_id),&json!(revision_id),&json!(hash)]))?;}
    let updated=execute(db,"UPDATE develop_history_heads SET revision_id=?,updated_at=?,retention_floor_ordinal=? WHERE catalog_id=? AND entry_id=? AND revision_id=?",values(&[&json!(revision_id),created_at,&json!((ordinal-499).max(0)),&json!(catalog_id),&json!(entry_id),&json!(expected)]))?;
    if updated!=1 { return Err("Develop history parent is stale.".into()) }
    if execute(db,"UPDATE entry_metadata SET develop_json=?,develop_updated_at=?,updated_at=? WHERE catalog_id=? AND entry_id=?",values(&[&json!(serialized),created_at,created_at,&json!(catalog_id),&json!(entry_id)]))?!=1{return Err("Develop history metadata is missing.".into())}
    let row=revision(db,catalog_id,entry_id,revision_id)?;
    Ok(json!({"revision":public_revision(&row),"idempotent":false}))
}

impl CatalogService {
    pub fn history_dispatch(&self,command:&str,args:&Value)->Result<Value,String> {
        let input=first(args)?;
        let id=string(input,"catalogId")?;
        if self.active.as_ref().is_none_or(|active| active.catalog_id!=id) { return Err("Catalog session is inactive.".into()) }
        let entry_id=string(input,"entryId")?;
        let db=self.db()?;
        match command {
            "darkroom:develop-history-load" => {
                loaded(db,id,entry_id,input.get("revisionId").and_then(Value::as_str))
            }
            "darkroom:develop-history-list" => {
                active_entry(db,id,entry_id)?;
                let limit=input.get("limit").and_then(Value::as_i64).unwrap_or(100).clamp(1,1000);
                let selected=rows(db,"SELECT catalog_id AS catalogId,entry_id AS entryId,revision_id AS revisionId,parent_revision_id AS parentRevisionId,operation_id AS operationId,ordinal,label,document_sha256 AS documentHash,checkpoint_json AS checkpointJson,created_at AS createdAt FROM develop_history_revisions WHERE catalog_id=? AND entry_id=? AND ordinal>=COALESCE((SELECT retention_floor_ordinal FROM develop_history_heads WHERE catalog_id=? AND entry_id=?),0) ORDER BY ordinal DESC LIMIT ?",values(&[&json!(id),&json!(entry_id),&json!(id),&json!(entry_id),&json!(limit)]))?;
                Ok(json!(selected.iter().map(public_revision).collect::<Vec<_>>()))
            }
            "darkroom:develop-history-refs" => {active_entry(db,id,entry_id)?;rows(db,"SELECT catalog_id AS catalogId,entry_id AS entryId,ref_id AS refId,kind,name,revision_id AS revisionId,created_at AS createdAt,updated_at AS updatedAt FROM develop_history_refs WHERE catalog_id=? AND entry_id=? ORDER BY kind,created_at,ref_id",values(&[&json!(id),&json!(entry_id)])).map(|v|json!(v))},
            "darkroom:develop-history-projection-get" => {active_entry(db,id,entry_id)?;Ok(one(db,"SELECT catalog_id AS catalogId,entry_id AS entryId,revision_id AS revisionId,content_sha256 AS contentSha256,projected_at AS projectedAt FROM develop_xmp_projections WHERE catalog_id=? AND entry_id=?",values(&[&json!(id),&json!(entry_id)]))?.unwrap_or(Value::Null))},
            "darkroom:develop-history-commit" => {
                db.execute_batch("BEGIN IMMEDIATE").map_err(|e|e.to_string())?;
                let result=commit(db,input);
                match result { Ok(v)=>{db.execute_batch("COMMIT").map_err(|e|e.to_string())?;Ok(v)},Err(e)=>{let _=db.execute_batch("ROLLBACK");Err(e)} }
            }
            "darkroom:develop-history-projection-set" => {
                active_entry(db,id,entry_id)?;
                let revision_id=uuid(input,"revisionId")?;
                let hash=string(input,"contentSha256")?;
                if hash.len()!=64 || !hash.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b)){return Err("Develop history projection digest is invalid.".into())}
                if !input["projectedAt"].as_f64().is_some_and(f64::is_finite){return Err("Develop history projectedAt is invalid.".into())}
                revision(db,id,entry_id,revision_id)?;
                execute(db,"INSERT INTO develop_xmp_projections (catalog_id,entry_id,revision_id,content_sha256,projected_at) VALUES (?,?,?,?,?) ON CONFLICT(catalog_id,entry_id) DO UPDATE SET revision_id=excluded.revision_id,content_sha256=excluded.content_sha256,projected_at=excluded.projected_at",values(&[&json!(id),&json!(entry_id),&json!(revision_id),&input["contentSha256"],&input["projectedAt"]]))?;
                Ok(input.clone())
            }
            "darkroom:develop-history-ref-mutate" => {
                db.execute_batch("BEGIN IMMEDIATE").map_err(|e|e.to_string())?;
                let result=self.history_ref_mutate(input);
                match result {Ok(v)=>{db.execute_batch("COMMIT").map_err(|e|e.to_string())?;Ok(v)},Err(e)=>{let _=db.execute_batch("ROLLBACK");Err(e)}}
            },
            _ => Err(format!("Unsupported develop history command: {command}")),
        }
    }

    #[allow(dead_code)]
    pub fn history_commit(&self,input:&Value)->Result<Value,String> {
        let db=self.db()?;
        db.execute_batch("BEGIN IMMEDIATE").map_err(|e|e.to_string())?;
        let result=commit(db,input);
        match result { Ok(v)=>{db.execute_batch("COMMIT").map_err(|e|e.to_string())?;Ok(v)},Err(e)=>{let _=db.execute_batch("ROLLBACK");Err(e)} }
    }

    fn history_ref_mutate(&self,input:&Value)->Result<Value,String> {
        let db=self.db()?;
        let id=uuid(input,"catalogId")?; let entry_id=uuid(input,"entryId")?;
        active_entry(db,id,entry_id)?;
        uuid(input,"refId")?;
        if input["name"].is_string() && (string(input,"name")?.trim().is_empty() || string(input,"name")?.len()>120 || string(input,"name")?!=string(input,"name")?.trim()){return Err("Develop history ref name is invalid.".into())}
        for key in ["createdAt","updatedAt"] {if input.get(key).is_some_and(|v|!v.as_f64().is_some_and(f64::is_finite)){return Err(format!("Develop history ref {key} is invalid."))}}
        match string(input,"kind")? {
            "create" => {if input["refKind"]!="version" && input["refKind"]!="snapshot" {return Err("Develop history ref kind is invalid.".into())}uuid(input,"revisionId")?;uuid(input,"expectedHeadRevisionId")?;if head(db,id,entry_id)?!=string(input,"expectedHeadRevisionId")? { return Err("Develop history Head changed before the reference was created.".into()) } revision(db,id,entry_id,string(input,"revisionId")?)?; let count=one(db,"SELECT COUNT(*) AS count FROM develop_history_refs WHERE catalog_id=? AND entry_id=? AND kind=?",values(&[&json!(id),&json!(entry_id),&input["refKind"]]))?.ok_or("Develop history ref count is missing.")?; if number(&count,"count")?>=100 { return Err("Develop history ref limit reached.".into()) } execute(db,"INSERT INTO develop_history_refs (catalog_id,entry_id,ref_id,kind,name,revision_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",values(&[&json!(id),&json!(entry_id),&input["refId"],&input["refKind"],&input["name"],&input["revisionId"],&input["createdAt"],&input["createdAt"]]))?; }
            "rename" => { if execute(db,"UPDATE develop_history_refs SET name=?,updated_at=? WHERE catalog_id=? AND entry_id=? AND ref_id=?",values(&[&input["name"],&input["updatedAt"],&json!(id),&json!(entry_id),&input["refId"]]))?!=1{return Err("Develop history ref is missing.".into())} }
            "move" => { if head(db,id,entry_id)?!=string(input,"expectedHeadRevisionId")? { return Err("Develop history Head is stale.".into()) } let old=one(db,"SELECT kind FROM develop_history_refs WHERE catalog_id=? AND entry_id=? AND ref_id=?",values(&[&json!(id),&json!(entry_id),&input["refId"]]))?.ok_or("Develop history ref is missing.")?; if old["kind"]=="snapshot" { return Err("Develop history snapshots cannot move.".into()) } revision(db,id,entry_id,string(input,"revisionId")?)?; execute(db,"UPDATE develop_history_refs SET revision_id=?,updated_at=? WHERE catalog_id=? AND entry_id=? AND ref_id=?",values(&[&input["revisionId"],&input["updatedAt"],&json!(id),&json!(entry_id),&input["refId"]]))?; }
            "delete" => { if execute(db,"DELETE FROM develop_history_refs WHERE catalog_id=? AND entry_id=? AND ref_id=?",values(&[&json!(id),&json!(entry_id),&input["refId"]]))?!=1{return Err("Develop history ref is missing.".into())} }
            kind => return Err(format!("Unsupported history ref mutation: {kind}")),
        }
        rows(db,"SELECT catalog_id AS catalogId,entry_id AS entryId,ref_id AS refId,kind,name,revision_id AS revisionId,created_at AS createdAt,updated_at AS updatedAt FROM develop_history_refs WHERE catalog_id=? AND entry_id=? ORDER BY kind,created_at,ref_id",values(&[&json!(id),&json!(entry_id)])).map(|v|json!(v))
    }
}
