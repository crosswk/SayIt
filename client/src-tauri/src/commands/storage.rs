use serde_json::Value;
use tauri::State;
use crate::storage::Storage;

#[tauri::command]
pub fn store_get(key: String, storage: State<Storage>) -> Result<Value, String> {
    Ok(storage.get(&key, None))
}

#[tauri::command]
pub fn store_set(key: String, value: Value, storage: State<Storage>) -> Result<(), String> {
    storage.set(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_delete(key: String, storage: State<Storage>) -> Result<(), String> {
    storage.delete(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_list(query: Option<Value>, storage: State<Storage>) -> Result<Vec<Value>, String> {
    let (keyword, favorite_only, limit, offset) = parse_history_query(&query);
    Ok(storage.history_list(keyword.as_deref(), favorite_only, limit, offset))
}

#[tauri::command]
pub fn history_count(query: Option<Value>, storage: State<Storage>) -> Result<i64, String> {
    let (keyword, favorite_only, _, _) = parse_history_query(&query);
    Ok(storage.history_count(keyword.as_deref(), favorite_only))
}

#[tauri::command]
pub fn history_add(record: Value, storage: State<Storage>) -> Result<(), String> {
    storage.history_add(&record).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_update(id: String, patch: Value, storage: State<Storage>) -> Result<(), String> {
    storage.history_update(&id, &patch).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_delete(id: String, storage: State<Storage>) -> Result<(), String> {
    storage.history_delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_set_favorite(id: String, favorite: bool, storage: State<Storage>) -> Result<(), String> {
    storage.history_set_favorite(&id, favorite).map_err(|e| e.to_string())
}

fn parse_history_query(query: &Option<Value>) -> (Option<String>, bool, Option<i64>, Option<i64>) {
    match query {
        Some(v) => {
            let keyword = v.get("keyword").and_then(|k| k.as_str()).map(|s| s.to_string());
            let favorite_only = v.get("favoriteOnly").and_then(|f| f.as_bool()).unwrap_or(false);
            let limit = v.get("limit").and_then(|l| l.as_i64());
            let offset = v.get("offset").and_then(|o| o.as_i64());
            (keyword, favorite_only, limit, offset)
        }
        None => (None, false, None, None),
    }
}
