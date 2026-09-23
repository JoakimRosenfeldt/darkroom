use std::{fs::{self, File, OpenOptions}, io::{BufReader, Read}, path::Path, time::UNIX_EPOCH};

use exif::{In, Tag, Value as ExifValue};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use xmpkit::{XmpFile, XmpValue};

use super::{assets::resolve_asset, NativeContext};

#[derive(Clone)]
struct Fact { value: Value, source: &'static str, tag: &'static str }
impl Fact {
    fn json(&self) -> Value { json!({"kind":"value","value":self.value,"source":self.source,"tag":self.tag}) }
}
fn absent() -> Value { json!({"kind":"absent"}) }
fn field(fact: Option<&Fact>) -> Value { fact.map(Fact::json).unwrap_or_else(absent) }
fn first(facts: &[Option<Fact>]) -> Option<Fact> { facts.iter().flatten().next().cloned() }
fn text(value: String, source: &'static str, tag: &'static str) -> Option<Fact> {
    let value = value.trim().trim_matches('\0').trim();
    if value.is_empty() { None } else { Some(Fact { value:json!(value),source,tag }) }
}
fn number(value: f64, source: &'static str, tag: &'static str) -> Option<Fact> {
    if value.is_finite() { Some(Fact{value:json!(value),source,tag}) } else { None }
}
fn exif_text(data: &exif::Exif, tag: Tag, name: &'static str) -> Option<Fact> {
    let field = data.get_field(tag,In::PRIMARY)?;
    let value = match &field.value {
        ExifValue::Ascii(values) => String::from_utf8_lossy(values.first()?).to_string(),
        _ => field.display_value().with_unit(data).to_string(),
    };
    text(value,"exif",name)
}
fn exif_number(data: &exif::Exif, tag: Tag, name: &'static str) -> Option<Fact> {
    let field = data.get_field(tag,In::PRIMARY)?;
    let value = match &field.value {
        ExifValue::Rational(values) => values.first()?.to_f64(),
        ExifValue::SRational(values) => values.first()?.to_f64(),
        _ => field.value.get_uint(0).map(f64::from)?,
    };
    number(value,"exif",name)
}
fn orientation(data: &exif::Exif) -> Option<Fact> {
    let value=data.get_field(Tag::Orientation,In::PRIMARY)?.value.get_uint(0)?;
    let translated=match value {
        1=>"Horizontal (normal)",2=>"Mirror horizontal",3=>"Rotate 180",4=>"Mirror vertical",
        5=>"Mirror horizontal and rotate 270 CW",6=>"Rotate 90 CW",7=>"Mirror horizontal and rotate 90 CW",8=>"Rotate 270 CW",_=>return None,
    };
    text(translated.into(),"exif","Orientation")
}
fn gps_coordinate(data: &exif::Exif, tag: Tag, reference: Tag, name: &'static str) -> Option<Fact> {
    let parts = match &data.get_field(tag, In::PRIMARY)?.value {
        ExifValue::Rational(parts) if parts.len() == 3 => parts,
        _ => return None,
    };
    let degrees = parts[0].to_f64() + parts[1].to_f64() / 60.0 + parts[2].to_f64() / 3600.0;
    let direction = match &data.get_field(reference, In::PRIMARY)?.value {
        ExifValue::Ascii(parts) => parts.first()?.first()?.to_ascii_uppercase(),
        _ => return None,
    };
    let signed = match direction { b'N' | b'E' => degrees, b'S' | b'W' => -degrees, _ => return None };
    if (tag == Tag::GPSLatitude && signed.abs() > 90.0) || (tag == Tag::GPSLongitude && signed.abs() > 180.0) {
        return None;
    }
    number(signed, "exif", name)
}
fn gps_altitude(data: &exif::Exif) -> Option<Fact> {
    let mut altitude = exif_number(data,Tag::GPSAltitude,"GPSAltitude")?;
    let below = data.get_field(Tag::GPSAltitudeRef,In::PRIMARY).and_then(|field|field.value.get_uint(0)).unwrap_or(0) == 1;
    if below { altitude.value = json!(-altitude.value.as_f64()?); }
    Some(altitude)
}
fn xmp_value(value: XmpValue) -> Value {
    match value {
        XmpValue::Array(values) => Value::Array(values.into_iter().map(xmp_value).collect()),
        XmpValue::Structure(values) => Value::Object(values.into_iter().map(|(key,value)|(key,xmp_value(value))).collect()),
        XmpValue::Integer(number) => json!(number),
        XmpValue::Boolean(flag) => json!(flag),
        XmpValue::String(text)|XmpValue::DateTime(text) => json!(text),
    }
}
fn normalized_text(value: Value) -> Option<String> {
    match value {
        Value::String(text) => { let text=text.trim().to_owned(); if text.is_empty(){None}else{Some(text)} },
        Value::Array(values) => values.into_iter().find_map(normalized_text),
        Value::Object(mut value) => value.remove("value").or_else(||value.remove("x-default")).and_then(normalized_text),
        _ => None,
    }
}
fn xmp_tag(namespace:&str,tag:&'static str)->&'static str {
    match (namespace,tag) {
        ("http://purl.org/dc/elements/1.1/","title")=>"dc.title",
        ("http://purl.org/dc/elements/1.1/","description")=>"dc.description",
        ("http://purl.org/dc/elements/1.1/","rights")=>"dc.rights",
        ("http://purl.org/dc/elements/1.1/","subject")=>"dc.subject",
        ("http://ns.adobe.com/lightroom/1.0/","hierarchicalSubject")=>"lr.hierarchicalSubject",
        ("http://ns.adobe.com/photoshop/1.0/","City")=>"photoshop.City",
        ("http://ns.adobe.com/photoshop/1.0/","State")=>"photoshop.State",
        ("http://ns.adobe.com/photoshop/1.0/","Country")=>"photoshop.Country",
        _=>tag,
    }
}
fn xmp_fact(meta: Option<&xmpkit::XmpMeta>, namespace: &'static str, tag: &'static str) -> Option<Fact> {
    let value = xmp_value(meta?.get_property(namespace,tag)?);
    text(normalized_text(value)?,"xmp",xmp_tag(namespace,tag))
}
fn xmp_list(meta: Option<&xmpkit::XmpMeta>, namespace: &'static str, tag: &'static str) -> Option<Fact> {
    let value = meta?.get_property(namespace,tag)?;
    let list = match value {
        XmpValue::Array(values) => values.into_iter().filter_map(|value|normalized_text(xmp_value(value))).collect::<Vec<_>>(),
        value => normalized_text(xmp_value(value)).into_iter().collect(),
    };
    let mut seen=std::collections::HashSet::new();
    let list: Vec<_> = list.into_iter().filter(|item|seen.insert(item.to_lowercase())).collect();
    if list.is_empty() {None} else {Some(Fact{value:json!(list),source:"xmp",tag:xmp_tag(namespace,tag)})}
}
fn iptc_fact(data: Option<&iptc::IPTC>, tag: iptc::IPTCTag, name: &'static str) -> Option<Fact> {
    text(data?.get(tag),"iptc",name)
}
fn iptc_list(data: Option<&iptc::IPTC>, tag: iptc::IPTCTag, name: &'static str) -> Option<Fact> {
    let values = data?.get_all().get(&tag)?.iter().filter_map(|value| normalized_text(json!(value))).collect::<Vec<_>>();
    if values.is_empty() {None} else {Some(Fact{value:json!(values),source:"iptc",tag:name})}
}
fn claim(field_name: &str, value: &Fact) -> Value { json!({"field":field_name,"value":value.value,"source":value.source,"tag":value.tag}) }
fn claims(field_name: &str, values: &[Option<Fact>], target: &mut Vec<Value>) {
    for value in values.iter().flatten() { target.push(claim(field_name,value)); }
}
pub(crate) fn sha256(path: &Path) -> Result<String,String> {
    let mut options=OpenOptions::new();options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC);
    }
    let mut file = options.open(path).map_err(|e|e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8;1024*1024];
    loop { let read = file.read(&mut buffer).map_err(|e|e.to_string())?; if read==0{break;} hasher.update(&buffer[..read]); }
    Ok(format!("{:x}",hasher.finalize()))
}
fn modified_ms(metadata: &fs::Metadata) -> Result<f64,String> {
    Ok(metadata.modified().map_err(|e|e.to_string())?.duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos() as f64/1_000_000.0)
}
fn now_ms() -> f64 { std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as f64 }
fn raw_extension(path: &Path) -> bool {
    matches!(path.extension().and_then(|v|v.to_str()).unwrap_or("").to_lowercase().as_str(),
        "3fr"|"arw"|"cr2"|"cr3"|"dng"|"erf"|"fff"|"iiq"|"kdc"|"mef"|"mos"|"mrw"|"nef"|"nrw"|"orf"|"pef"|"raf"|"raw"|"rw2"|"rwl"|"sr2"|"srf"|"srw"|"x3f")
}
fn days_from_civil(year:i64, month:i64, day:i64)->i64 {
    let year=year-i64::from(month<=2);
    let era=if year>=0 {year} else {year-399}/400;
    let yoe=year-era*400;
    let month=month+if month>2{-3}else{9};
    let doy=(153*month+2)/5+day-1;
    let doe=yoe*365+yoe/4-yoe/100+doy;
    era*146097+doe-719468
}
fn capture_time(fact: Option<&Fact>, offset_fact: Option<&Fact>) -> (Value,Value,Value,Value) {
    let Some(fact)=fact else {return (absent(),Value::Null,Value::Null,Value::Null);};
    let Some(raw)=fact.value.as_str() else {return (absent(),Value::Null,Value::Null,Value::Null);};
    let malformed=|| (json!({"kind":"malformed","message":format!("{} is not a valid capture time.",fact.tag)}),Value::Null,Value::Null,Value::Null);
    let bytes=raw.as_bytes();
    if bytes.len()<19 || !matches!(bytes[4],b':'|b'-') || !matches!(bytes[7],b':'|b'-') || !matches!(bytes[10],b' '|b'T') || bytes[13]!=b':' || bytes[16]!=b':' {return malformed()}
    let parse=|start:usize,end:usize|->Option<i64>{let digits=bytes.get(start..end)?;if digits.iter().all(u8::is_ascii_digit){std::str::from_utf8(digits).ok()?.parse().ok()}else{None}};
    let Some((year,month,day,hour,minute,second))=parse(0,4).zip(parse(5,7)).zip(parse(8,10)).zip(parse(11,13)).zip(parse(14,16)).zip(parse(17,19)).map(|(((((y,m),d),h),minute),s)|(y,m,d,h,minute,s)) else{return malformed()};
    if year<1 || !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour>23 || minute>59 || second>60 {
        return malformed();
    }
    let wall=format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}");
    let milliseconds=if bytes.get(19)==Some(&b'.') {let digits=bytes[20..].iter().take_while(|byte|byte.is_ascii_digit()).take(3).copied().collect::<Vec<_>>();let mut padded=digits;while padded.len()<3{padded.push(b'0')}parse_ms(&padded)}else{0};
    let offset=offset_fact.and_then(|value|value.value.as_str()).filter(|value|{
        let bytes=value.as_bytes();
        *value=="Z" || (bytes.len()==6 && matches!(bytes[0],b'+'|b'-') && bytes[1..3].iter().all(u8::is_ascii_digit) && bytes[3]==b':' && bytes[4..6].iter().all(u8::is_ascii_digit) && bytes[1..3]<=b"23"[..] && bytes[4..6]<=b"59"[..])
    }).map(str::to_owned);
    let mut sort=(days_from_civil(year,month,day)*86400+hour*3600+minute*60+second)*1000+milliseconds;
    if let Some(offset)=&offset {
        if offset!="Z" {
            let hours=offset[1..3].parse::<i64>().unwrap_or(0);
            let minutes=offset[4..6].parse::<i64>().unwrap_or(0);
            let direction=if offset.starts_with('-') {-1} else {1};
            sort-=direction*(hours*60+minutes)*60_000;
        }
    }
    let time=json!({"value":wall,"offset":offset,"sortKey":sort});
    (json!({"kind":"value","value":time,"source":fact.source,"tag":fact.tag}),json!(sort),json!(format!("{wall}{}",offset.as_deref().unwrap_or(""))),json!(if fact.tag=="DateTimeOriginal" {"date-time-original"} else {"create-date"}))
}

fn parse_ms(digits:&[u8])->i64 {digits.iter().fold(0_i64,|acc,byte|acc*10+i64::from(byte-b'0'))}

pub fn analyze_file(location: &Value, _ctx: &NativeContext) -> Result<Value,String> {
    analyze_file_with_digest(location,None)
}

pub(crate) fn analyze_file_with_digest(location: &Value, known_digest: Option<String>) -> Result<Value,String> {
    let path=resolve_asset(location)?;
    let metadata=fs::metadata(&path).map_err(|e|e.to_string())?;
    let size=metadata.len();
    let modified=modified_ms(&metadata)?;
    let analyzed=now_ms();
    let digest=match known_digest { Some(digest)=>digest, None=>sha256(&path)? };
    let adapter=format!("1.0.0-{}",if raw_extension(&path){"raw"}else{"standard"});
    let exif=File::open(&path).ok().and_then(|file|exif::Reader::new().read_from_container(&mut BufReader::new(file)).ok());
    let exif=exif.as_ref();
    let mut xmp_file=XmpFile::new();
    let xmp=if xmp_file.open(&path).is_ok(){xmp_file.get_xmp()}else{None};
    let iptc=iptc::IPTC::read_from_path(&path).ok();
    let iptc=iptc.as_ref();
    const DC:&str="http://purl.org/dc/elements/1.1/";
    const PHOTOSHOP:&str="http://ns.adobe.com/photoshop/1.0/";
    const LR:&str="http://ns.adobe.com/lightroom/1.0/";
    let title_candidates=[xmp_fact(xmp,DC,"title"),iptc_fact(iptc,iptc::IPTCTag::ObjectName,"ObjectName").or_else(||iptc_fact(iptc,iptc::IPTCTag::Headline,"Headline")),exif.and_then(|exif|exif_text(exif,Tag::ImageDescription,"ImageDescription"))];
    let caption_candidates=[xmp_fact(xmp,DC,"description"),iptc_fact(iptc,iptc::IPTCTag::Caption,"Caption").or_else(||iptc_fact(iptc,iptc::IPTCTag::LocalCaption,"LocalCaption")),exif.and_then(|exif|exif_text(exif,Tag::ImageDescription,"ImageDescription").or_else(||exif_text(exif,Tag::UserComment,"UserComment")))];
    let copyright_candidates=[xmp_fact(xmp,DC,"rights"),iptc_fact(iptc,iptc::IPTCTag::CopyrightNotice,"CopyrightNotice"),exif.and_then(|exif|exif_text(exif,Tag::Copyright,"Copyright").or_else(||exif_text(exif,Tag::Artist,"Artist")))];
    let keyword_candidates=[xmp_list(xmp,DC,"subject").or_else(||xmp_list(xmp,LR,"hierarchicalSubject")),iptc_list(iptc,iptc::IPTCTag::Keywords,"Keywords").or_else(||iptc_list(iptc,iptc::IPTCTag::SubjectReference,"SubjectReference"))];
    let mut all_claims=Vec::new();
    claims("title",&title_candidates,&mut all_claims);
    claims("caption",&caption_candidates,&mut all_claims);
    claims("copyright",&copyright_candidates,&mut all_claims);
    claims("keywords",&keyword_candidates,&mut all_claims);
    let make=exif.and_then(|exif|exif_text(exif,Tag::Make,"Make"));
    let model=exif.and_then(|exif|exif_text(exif,Tag::Model,"Model"));
    let lens=exif.and_then(|exif|exif_text(exif,Tag::LensModel,"LensModel"));
    let focal=exif.and_then(|exif|exif_number(exif,Tag::FocalLength,"FocalLength"));
    let aperture=exif.and_then(|exif|exif_number(exif,Tag::FNumber,"FNumber"));
    let shutter=exif.and_then(|exif|exif_number(exif,Tag::ExposureTime,"ExposureTime"));
    let iso=exif.and_then(|exif|exif_number(exif,Tag::PhotographicSensitivity,"ISOSpeedRatings"));
    let date=exif.and_then(|exif|exif_text(exif,Tag::DateTimeOriginal,"DateTimeOriginal"))
        .or_else(||exif.and_then(|exif|exif_text(exif,Tag::DateTimeDigitized,"CreateDate")));
    let date_offset=exif.and_then(|exif|exif_text(exif,Tag::OffsetTimeOriginal,"OffsetTimeOriginal"));
    let (capture,capture_key,capture_display,capture_provenance)=capture_time(date.as_ref(),date_offset.as_ref());
    let fallback=&location["fallback"];
    let fallback_fact=|key:&str,tag:&'static str|->Option<Fact>{ fallback.get(key).and_then(Value::as_str).and_then(|value|text(value.to_owned(),"catalog-fallback",tag)) };
    let make=make.or_else(||fallback_fact("cameraMake","catalog.cameraMake"));
    let model=model.or_else(||fallback_fact("cameraModel","catalog.cameraModel"));
    let lens=lens.or_else(||fallback_fact("lens","catalog.lensModel"));
    let width=exif.and_then(|exif|exif_number(exif,Tag::PixelXDimension,"exif.ExifImageWidth")).map(|mut value|{value.source="container";value});
    let height=exif.and_then(|exif|exif_number(exif,Tag::PixelYDimension,"exif.ExifImageHeight")).map(|mut value|{value.source="container";value});
    let orientation=exif.and_then(orientation);
    let bit_depth=exif.and_then(|exif|exif_number(exif,Tag::BitsPerSample,"BitsPerSample"));
    let color_space=exif.and_then(|exif|exif_text(exif,Tag::ColorSpace,"ColorSpace"));
    let city=xmp_fact(xmp,PHOTOSHOP,"City").or_else(||iptc_fact(iptc,iptc::IPTCTag::City,"City"));
    let state=xmp_fact(xmp,PHOTOSHOP,"State").or_else(||iptc_fact(iptc,iptc::IPTCTag::ProvinceOrState,"ProvinceState"));
    let country=xmp_fact(xmp,PHOTOSHOP,"Country").or_else(||iptc_fact(iptc,iptc::IPTCTag::CountryOrPrimaryLocationName,"CountryName"));
    let latitude=exif.and_then(|exif|gps_coordinate(exif,Tag::GPSLatitude,Tag::GPSLatitudeRef,"GPSLatitude"));
    let longitude=exif.and_then(|exif|gps_coordinate(exif,Tag::GPSLongitude,Tag::GPSLongitudeRef,"GPSLongitude"));
    let altitude=exif.and_then(gps_altitude);
    let source=json!({"version":1,"parserVersion":"kamadak-exif-0.6.1+xmpkit-0.1.6+iptc-0.3","adapterVersion":adapter,"sourceSha256":digest,"extractedAt":analyzed,
        "file":{"byteLength":size,"modifiedAt":modified,"width":field(width.as_ref()),"height":field(height.as_ref()),"orientation":field(orientation.as_ref()),"bitDepth":field(bit_depth.as_ref()),"colorSpace":field(color_space.as_ref())},
        "capture":{"time":capture,"cameraMake":field(make.as_ref()),"cameraModel":field(model.as_ref()),"lens":field(lens.as_ref()),"focalLength":field(focal.as_ref()),"aperture":field(aperture.as_ref()),"shutter":field(shutter.as_ref()),"iso":field(iso.as_ref())},
        "description":{"title":field(first(&title_candidates).as_ref()),"caption":field(first(&caption_candidates).as_ref()),"copyright":field(first(&copyright_candidates).as_ref()),"keywords":field(first(&keyword_candidates).as_ref())},
        "location":{"latitude":field(latitude.as_ref()),"longitude":field(longitude.as_ref()),"altitude":field(altitude.as_ref()),"city":field(city.as_ref()),"state":field(state.as_ref()),"country":field(country.as_ref())},
        "claims":all_claims,"warnings":[]});
    Ok(json!({"cacheSignature":format!("{size}:{modified}"),"size":size,"modifiedAt":modified,"sourceSha256":digest,"parserVersion":source["parserVersion"],"adapterVersion":adapter,"cacheHit":false,"source":source,
        "captureTimeKey":capture_key,"captureTimeDisplay":capture_display,"captureTimeProvenance":capture_provenance,"cameraMake":make.as_ref().map(|v|v.value.clone()),"cameraModel":model.as_ref().map(|v|v.value.clone()),"lens":lens.as_ref().map(|v|v.value.clone()),"iso":iso.as_ref().map(|v|v.value.clone()),"focalLength":focal.as_ref().map(|v|v.value.clone()),
        "location":{"city":city.as_ref().map(|v|v.value.clone()),"state":state.as_ref().map(|v|v.value.clone()),"country":country.as_ref().map(|v|v.value.clone())},"hasGps":latitude.is_some()&&longitude.is_some(),"error":null,"analyzedAt":analyzed}))
}
