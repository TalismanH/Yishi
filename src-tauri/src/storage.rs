use chrono::{DateTime, NaiveDate, NaiveDateTime, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PAYLOAD_LIMIT: usize = 5 * 1024 * 1024;
const FILE_LIMIT: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct StoreError {
    pub status: u16,
    pub message: String,
}

impl StoreError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for StoreError {}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Snapshot {
    pub state: Value,
    pub revision: u64,
}

#[derive(Debug, Serialize)]
pub struct Saved {
    pub revision: u64,
}

#[derive(Clone, Debug)]
pub struct Store {
    directory: PathBuf,
    legacy_directories: Vec<PathBuf>,
}

struct StoredSnapshot {
    snapshot: Snapshot,
    bytes: Vec<u8>,
}

fn io_error(_: io::Error) -> StoreError {
    StoreError::new(
        500,
        "本地数据读写失败，原数据已保留，请检查磁盘空间和文件权限",
    )
}

fn absolute(path: PathBuf) -> Result<PathBuf, StoreError> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir().map_err(io_error)?.join(path))
    }
}

impl Store {
    pub fn new(directory: PathBuf, legacy_directories: Vec<PathBuf>) -> Self {
        let mut seen = HashSet::new();
        let legacy_directories = legacy_directories
            .into_iter()
            .filter(|path| {
                let key = path.canonicalize().unwrap_or_else(|_| path.clone());
                #[cfg(windows)]
                let key = key.to_string_lossy().to_lowercase();
                seen.insert(key)
            })
            .collect();
        Self {
            directory,
            legacy_directories,
        }
    }

    pub fn from_environment(default_directory: PathBuf) -> Result<Self, StoreError> {
        let target = env::var_os("TODO_DATA_DIR").filter(|value| !value.is_empty());
        let legacy = env::var_os("TODO_LEGACY_DATA_DIR").filter(|value| !value.is_empty());
        let mut candidates = Vec::new();
        if let Some(legacy) = legacy {
            candidates.push(absolute(PathBuf::from(legacy))?);
        } else if target.is_none() {
            #[cfg(debug_assertions)]
            if let Some(repo) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
                candidates.push(repo.join("data"));
            }
            if let Ok(executable) = env::current_exe() {
                if let Some(parent) = executable.parent() {
                    candidates.push(parent.join("data"));
                }
            }
            if let Ok(directory) = env::current_dir() {
                candidates.push(directory.join("data"));
            }
        }
        Ok(Self::new(
            absolute(target.map(PathBuf::from).unwrap_or(default_directory))?,
            candidates,
        ))
    }

    fn lock(&self) -> Result<File, StoreError> {
        fs::create_dir_all(&self.directory).map_err(io_error)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.directory.join("storage.lock"))
            .map_err(io_error)?;
        lock.lock().map_err(io_error)?;
        Ok(lock)
    }

    pub fn load(&self, initial_state: Value) -> Result<Snapshot, StoreError> {
        let _lock = self.lock()?;
        let filename = self.directory.join("workspace.json");
        if let Some(current) = read_snapshot(&filename)? {
            return Ok(current.snapshot);
        }
        for directory in &self.legacy_directories {
            if let Some(legacy) = read_snapshot(&directory.join("workspace.json"))? {
                let backup = self.directory.join("workspace.json.migration.bak");
                if read_snapshot(&backup)?.is_none() {
                    atomic_write(&backup, &legacy.bytes)?;
                }
                atomic_write(&filename, &legacy.bytes)?;
                return Ok(legacy.snapshot);
            }
        }
        validate_state(&initial_state)?;
        check_payload(&initial_state, 0)?;
        let snapshot = Snapshot {
            state: initial_state,
            revision: 0,
        };
        let bytes = serde_json::to_vec_pretty(&snapshot)
            .map_err(|_| StoreError::new(400, "工作区无法序列化"))?;
        atomic_write(&filename, &bytes)?;
        Ok(snapshot)
    }

    pub fn save(&self, state: Value, revision: u64) -> Result<Saved, StoreError> {
        validate_state(&state)?;
        if revision > MAX_SAFE_INTEGER {
            return Err(StoreError::new(400, "无效的数据版本"));
        }
        check_payload(&state, revision)?;
        let _lock = self.lock()?;
        let filename = self.directory.join("workspace.json");
        let previous = read_snapshot(&filename)?
            .ok_or_else(|| StoreError::new(409, "工作区尚未加载，请重新打开"))?;
        if revision != previous.snapshot.revision {
            return Err(StoreError::new(
                409,
                "数据已在其他窗口更新，请导出当前内容后重新打开",
            ));
        }
        let next_revision = revision
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| StoreError::new(400, "数据版本已达上限"))?;
        let next = Snapshot {
            state,
            revision: next_revision,
        };
        let bytes = serde_json::to_vec_pretty(&next)
            .map_err(|_| StoreError::new(400, "工作区无法序列化"))?;
        let temporary = write_temporary(&filename, &bytes)?;
        atomic_write(&self.directory.join("workspace.json.bak"), &previous.bytes)?;
        fs::rename(temporary, filename).map_err(io_error)?;
        Ok(Saved {
            revision: next_revision,
        })
    }
}

fn write_temporary(filename: &Path, bytes: &[u8]) -> Result<PathBuf, StoreError> {
    let temporary = filename.with_file_name(format!(
        "{}.tmp",
        filename.file_name().unwrap().to_string_lossy()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temporary)
        .map_err(io_error)?;
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    Ok(temporary)
}

fn atomic_write(filename: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    fs::rename(write_temporary(filename, bytes)?, filename).map_err(io_error)
}

fn read_snapshot(filename: &Path) -> Result<Option<StoredSnapshot>, StoreError> {
    let file = match File::open(filename) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err(StoreError::new(500, "本地数据文件过大，已保留原文件"));
    }
    let parsed = (|| {
        let envelope: Value = serde_json::from_slice(&bytes).ok()?;
        let state = envelope.get("state")?.clone();
        validate_state(&state).ok()?;
        let revision = safe_integer(envelope.get("revision")?)?;
        Some(Snapshot { state, revision })
    })();
    parsed
        .map(|snapshot| Some(StoredSnapshot { snapshot, bytes }))
        .ok_or_else(|| StoreError::new(500, "数据文件无法读取，已保留原文件，请从备份恢复"))
}

fn check_payload(state: &Value, revision: u64) -> Result<(), StoreError> {
    let bytes = serde_json::to_vec(&json!({"state":state,"revision":revision}))
        .map_err(|_| StoreError::new(400, "工作区无法序列化"))?;
    if bytes.len() > PAYLOAD_LIMIT {
        return Err(StoreError::new(413, "数据超过 5 MB 限制"));
    }
    Ok(())
}

fn safe_integer(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|number| {
            number.is_finite()
                && *number >= 0.0
                && *number <= MAX_SAFE_INTEGER as f64
                && number.fract() == 0.0
        })
        .map(|number| number as u64)
}

fn blank(value: &str) -> bool {
    value.chars().all(|c| matches!(c, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

fn text<'a>(
    value: Option<&'a Value>,
    max: usize,
    label: &str,
    allow_empty: bool,
) -> Result<&'a str, StoreError> {
    let value = value
        .and_then(Value::as_str)
        .filter(|value| value.encode_utf16().count() <= max && (allow_empty || !blank(value)));
    value.ok_or_else(|| StoreError::new(400, format!("{label}格式不正确")))
}

fn valid_date(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    let value =
        value.trim_matches(|c| matches!(c, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{feff}'));
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return date.nanosecond() < 1_000_000_000
            && date.timestamp_millis().unsigned_abs() <= 8_640_000_000_000_000;
    }
    if let Ok(date) = DateTime::parse_from_rfc2822(value) {
        return date.nanosecond() < 1_000_000_000;
    }
    let date = match value.len() {
        4 => format!("{value}-01-01"),
        7 => format!("{value}-01"),
        _ => value.to_owned(),
    };
    NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_ok()
        || [
            "%Y-%m-%dT%H:%M:%S%.f",
            "%Y-%m-%dT%H:%M",
            "%Y-%m-%d %H:%M:%S%.f",
            "%Y-%m-%d %H:%M",
        ]
        .iter()
        .any(|format| {
            NaiveDateTime::parse_from_str(value, format)
                .is_ok_and(|date| date.nanosecond() < 1_000_000_000)
        })
}

pub fn validate_state(state: &Value) -> Result<(), StoreError> {
    if state.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err(StoreError::new(400, "工作区格式不正确"));
    }
    let projects = state
        .get("projects")
        .and_then(Value::as_array)
        .filter(|projects| projects.len() <= 1000)
        .ok_or_else(|| StoreError::new(400, "工作区格式不正确"))?;
    let mut project_ids = HashSet::new();
    for project in projects {
        let id = text(project.get("id"), 100, "项目编号", false)?;
        if !project_ids.insert(id) {
            return Err(StoreError::new(400, "项目编号不能重复"));
        }
        text(project.get("name"), 120, "项目名称", false)?;
        text(project.get("summary"), 100000, "项目总体情况", true)?;
        if !project.get("createdAt").is_some_and(valid_date) {
            return Err(StoreError::new(400, "项目创建时间不正确"));
        }
        if !project
            .get("archivedAt")
            .is_some_and(|value| value.is_null() || valid_date(value))
        {
            return Err(StoreError::new(400, "项目归档时间不正确"));
        }
        let tasks = project
            .get("tasks")
            .and_then(Value::as_array)
            .filter(|tasks| tasks.len() <= 10000)
            .ok_or_else(|| StoreError::new(400, "事项列表格式不正确"))?;
        let mut parents = HashMap::new();
        for task in tasks {
            let id = text(task.get("id"), 100, "事项编号", false)?;
            text(task.get("title"), 20000, "事项内容", true)?;
            let parent = match task.get("parentId") {
                Some(Value::Null) => None,
                other => Some(text(other, 100, "父事项编号", false)?),
            };
            if parents.insert(id, parent).is_some() {
                return Err(StoreError::new(400, "事项编号不能重复"));
            }
            if !matches!(
                task.get("status").and_then(Value::as_str),
                Some("todo" | "doing" | "done")
            ) {
                return Err(StoreError::new(400, "事项状态不正确"));
            }
            if task.get("order").and_then(safe_integer).is_none() {
                return Err(StoreError::new(400, "事项排序不正确"));
            }
        }
        for id in parents.keys() {
            let mut current = Some(*id);
            let mut visited = HashSet::new();
            while let Some(id) = current {
                if !visited.insert(id) {
                    return Err(StoreError::new(400, "事项层级不能形成循环"));
                }
                if visited.len() > 3 {
                    return Err(StoreError::new(400, "事项最多支持三级"));
                }
                current = *parents
                    .get(id)
                    .ok_or_else(|| StoreError::new(400, "父事项不存在"))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Barrier,
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = env::temp_dir().join(format!(
                "yishi-native-test-{}-{}-{stamp}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            assert!(self.0.starts_with(env::temp_dir()));
            assert!(self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("yishi-native-test-"));
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn state() -> Value {
        json!({"version":1,"projects":[{"id":"p","name":"测试项目","summary":"  **原文**\n\n$x^2$  \n下一行","createdAt":"2026-10-31T12:34:56.789Z","archivedAt":null,"tasks":[
            {"id":"a","parentId":null,"title":"主事项","status":"doing","order":0},
            {"id":"b","parentId":"a","title":"二级事项","status":"todo","order":0},
            {"id":"c","parentId":"b","title":"三级事项","status":"todo","order":0}
        ]}]})
    }
    fn store(directory: &Directory) -> Store {
        Store::new(directory.0.join("native"), Vec::new())
    }

    #[test]
    fn seeds_saves_and_restarts_preserving_markdown_and_empty_tasks() {
        let directory = Directory::new();
        let store = store(&directory);
        let initial = store.load(state()).unwrap();
        assert_eq!(initial.revision, 0);
        let old = fs::read(store.directory.join("workspace.json")).unwrap();
        let mut changed = initial.state;
        changed["projects"][0]["name"] = json!("更新后的项目");
        changed["projects"][0]["tasks"][0]["title"] = json!("");
        assert_eq!(store.save(changed.clone(), 0).unwrap().revision, 1);
        let restarted = Store::new(store.directory.clone(), Vec::new());
        assert_eq!(
            restarted.load(json!(null)).unwrap(),
            Snapshot {
                state: changed,
                revision: 1
            }
        );
        assert_eq!(
            fs::read(store.directory.join("workspace.json.bak")).unwrap(),
            old
        );
    }

    #[test]
    fn migrates_a_valid_legacy_envelope_once_and_keeps_source_and_snapshot() {
        let directory = Directory::new();
        let legacy = directory.0.join("legacy");
        fs::create_dir(&legacy).unwrap();
        let bytes = serde_json::to_vec_pretty(&Snapshot {
            state: state(),
            revision: 17,
        })
        .unwrap();
        fs::write(legacy.join("workspace.json"), &bytes).unwrap();
        let store = Store::new(
            directory.0.join("native"),
            vec![legacy.clone(), legacy.clone()],
        );
        assert_eq!(store.legacy_directories.len(), 1);
        let migrated = store.load(json!(null)).unwrap();
        assert_eq!(migrated.revision, 17);
        for path in [
            legacy.join("workspace.json"),
            store.directory.join("workspace.json"),
            store.directory.join("workspace.json.migration.bak"),
        ] {
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
        store.save(migrated.state, 17).unwrap();
        assert_eq!(store.load(state()).unwrap().revision, 18);
        assert_eq!(
            fs::read(store.directory.join("workspace.json.migration.bak")).unwrap(),
            bytes
        );
        assert_eq!(fs::read(legacy.join("workspace.json")).unwrap(), bytes);
    }

    #[test]
    fn stale_instances_and_threads_cannot_overwrite_a_newer_revision() {
        let directory = Directory::new();
        let first = store(&directory);
        first.load(state()).unwrap();
        let second = first.clone();
        first.save(state(), 0).unwrap();
        assert_eq!(second.save(state(), 0).unwrap_err().status, 409);
        let barrier = Arc::new(Barrier::new(3));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let store = first.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store
                        .save(state(), 1)
                        .map(|saved| saved.revision)
                        .map_err(|error| error.status)
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| **result == Ok(2)).count(), 1);
        assert_eq!(
            results.iter().filter(|result| **result == Err(409)).count(),
            1
        );
        assert_eq!(first.load(state()).unwrap().revision, 2);
    }

    #[test]
    fn invalid_target_or_source_is_never_replaced_with_seed_data() {
        let directory = Directory::new();
        let store = store(&directory);
        fs::create_dir_all(&store.directory).unwrap();
        fs::write(store.directory.join("workspace.json"), b"{broken").unwrap();
        assert_eq!(store.load(state()).unwrap_err().status, 500);
        assert_eq!(
            fs::read(store.directory.join("workspace.json")).unwrap(),
            b"{broken"
        );
        let legacy = directory.0.join("legacy");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("workspace.json"), b"bad").unwrap();
        let destination = Store::new(directory.0.join("another"), vec![legacy.clone()]);
        assert_eq!(destination.load(state()).unwrap_err().status, 500);
        assert!(!destination.directory.join("workspace.json").exists());
        assert_eq!(fs::read(legacy.join("workspace.json")).unwrap(), b"bad");
    }

    #[test]
    fn failed_save_retains_previous_file_and_revision() {
        let directory = Directory::new();
        let store = store(&directory);
        store.load(state()).unwrap();
        let before = fs::read(store.directory.join("workspace.json")).unwrap();
        fs::create_dir(store.directory.join("workspace.json.tmp")).unwrap();
        assert_eq!(store.save(state(), 0).unwrap_err().status, 500);
        assert_eq!(
            fs::read(store.directory.join("workspace.json")).unwrap(),
            before
        );
        assert_eq!(store.load(state()).unwrap().revision, 0);
    }

    #[test]
    fn rejects_invalid_hierarchy_ids_status_dates_and_safe_integer_values() {
        let mut variants = Vec::new();
        let mut value = state();
        value["projects"][0]["tasks"][0]["parentId"] = json!("c");
        variants.push(value);
        let mut value = state();
        value["projects"][0]["tasks"][2]["parentId"] = json!("missing");
        variants.push(value);
        let mut value = state();
        value["projects"][0]["tasks"][1]["id"] = json!("a");
        variants.push(value);
        let mut value = state();
        let duplicate = value["projects"][0].clone();
        value["projects"].as_array_mut().unwrap().push(duplicate);
        variants.push(value);
        let mut value = state();
        value["projects"][0]["createdAt"] = json!("not-a-date");
        variants.push(value);
        let mut value = state();
        value["projects"][0]["archivedAt"] = json!("2026-13-45");
        variants.push(value);
        let mut value = state();
        value["projects"][0]["tasks"][0]["status"] = json!("unknown");
        variants.push(value);
        let mut value = state();
        value["projects"][0]["tasks"][0]["order"] = json!(9_007_199_254_740_992u64);
        variants.push(value);
        let mut value = state();
        value["projects"][0]["tasks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"fourth","parentId":"c","title":"第四级","status":"todo","order":0}));
        variants.push(value);
        for value in variants {
            assert_eq!(validate_state(&value).unwrap_err().status, 400);
        }
    }

    #[test]
    fn string_limits_use_javascript_utf16_units_and_keep_known_iso_dates() {
        let mut value = state();
        value["projects"][0]["name"] = json!("😀".repeat(60));
        validate_state(&value).unwrap();
        value["projects"][0]["name"] = json!("😀".repeat(61));
        assert!(validate_state(&value).is_err());
        for date in [
            "2026-10-31T12:34:56.789Z",
            "2026-10-31T20:34:56+08:00",
            "2026-10-31",
            "2026-10",
            "2026",
        ] {
            let mut value = state();
            value["projects"][0]["createdAt"] = json!(date);
            validate_state(&value).unwrap();
        }
        assert!(blank("\u{feff}\u{a0}"));
        assert!(!blank("\u{85}"));
    }

    #[test]
    fn bounds_save_payloads_but_accepts_existing_pretty_json() {
        let directory = Directory::new();
        let store = store(&directory);
        store.load(state()).unwrap();
        let before = fs::read(store.directory.join("workspace.json")).unwrap();
        let mut value = state();
        value["extra"] = json!("x".repeat(PAYLOAD_LIMIT));
        assert_eq!(store.save(value, 0).unwrap_err().status, 413);
        assert_eq!(
            fs::read(store.directory.join("workspace.json")).unwrap(),
            before
        );
        let mut large = state();
        large["projects"][0]["tasks"] = json!((0..10000).map(|order| json!({"id":format!("task-{order}"),"parentId":null,"title":"x".repeat(375),"status":"todo","order":order})).collect::<Vec<_>>());
        check_payload(&large, 12).unwrap();
        let pretty = serde_json::to_vec_pretty(&Snapshot {
            state: large.clone(),
            revision: 12,
        })
        .unwrap();
        assert!(pretty.len() > PAYLOAD_LIMIT);
        fs::write(store.directory.join("workspace.json"), pretty).unwrap();
        assert_eq!(
            store.load(state()).unwrap(),
            Snapshot {
                state: large,
                revision: 12
            }
        );
    }
}
