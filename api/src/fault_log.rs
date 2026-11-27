use std::collections::{HashMap, VecDeque};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::timings::Fault;

pub(crate) const FILE: &str = "errors.json";
pub(crate) const KEEP_PER_LINE: usize = 500;
pub(crate) const KEEP_PER_BOX: usize = 20_000;
pub(crate) const KEEP_MS: i64 = 7 * 86_400_000;
pub(crate) const PULL_PER_ROUND: usize = 24;

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
pub(crate) struct Log {
    boxes: HashMap<String, BoxLog>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
struct BoxLog {
    since: Option<i64>,
    lines: HashMap<String, VecDeque<Fault>>,
}

impl Log {
    pub(crate) fn keep_boxes(&mut self, names: &[String], now_ms: i64) {
        self.boxes.retain(|name, _| names.contains(name));
        for name in names {
            self.boxes.entry(name.clone()).or_default().since.get_or_insert(now_ms);
        }
    }

    pub(crate) fn merge(&mut self, target: &str, key: &str, fetched: &[Fault], now_ms: i64) -> usize {
        let b = self.boxes.entry(target.to_owned()).or_default();
        b.since.get_or_insert(now_ms);
        let line = b.lines.entry(key.to_owned()).or_default();
        let newest = line.back().map(|f| f.at);
        let mut fresh: Vec<&Fault> = fetched
            .iter()
            .filter(|f| f.at > now_ms - KEEP_MS)
            .filter(|f| match newest {
                None => true,
                Some(n) => f.at > n || (f.at == n && !line.iter().rev().take_while(|x| x.at == n).any(|x| x == *f)),
            })
            .collect();
        fresh.sort_by_key(|f| f.at);
        let added = fresh.len();
        line.extend(fresh.into_iter().cloned());
        while line.len() > KEEP_PER_LINE {
            line.pop_front();
        }
        if line.is_empty() {
            b.lines.remove(key);
        }
        added
    }

    pub(crate) fn prune(&mut self, now_ms: i64) {
        let floor = now_ms - KEEP_MS;
        for b in self.boxes.values_mut() {
            for line in b.lines.values_mut() {
                while line.front().is_some_and(|f| f.at <= floor) {
                    line.pop_front();
                }
            }
            b.lines.retain(|_, line| !line.is_empty());
            let total: usize = b.lines.values().map(VecDeque::len).sum();
            if total <= KEEP_PER_BOX {
                continue;
            }
            let mut ats: Vec<i64> = b.lines.values().flat_map(|l| l.iter().map(|f| f.at)).collect();
            ats.sort_unstable();
            let excess = total - KEEP_PER_BOX;
            let cut = ats[excess - 1];
            let mut over = ats[..excess].iter().filter(|&&a| a == cut).count();
            for line in b.lines.values_mut() {
                while let Some(f) = line.front() {
                    if f.at < cut {
                        line.pop_front();
                    } else if f.at == cut && over > 0 {
                        line.pop_front();
                        over -= 1;
                    } else {
                        break;
                    }
                }
            }
            b.lines.retain(|_, line| !line.is_empty());
        }
    }

    pub(crate) fn answer(&self, target: &str, key: &str, from_ms: i64) -> Value {
        let b = self.boxes.get(target);
        let line = b.and_then(|b| b.lines.get(key));
        let rows: Vec<&Fault> = line.map(|l| l.iter().rev().take_while(|f| f.at >= from_ms).collect()).unwrap_or_default();
        json!({
            "rows": rows,
            "kept": rows.len(),
            "cap": KEEP_PER_LINE,
            "since": b.and_then(|b| b.since),
            "from": from_ms,
            "box_kept": self.total(target),
            "box_cap": KEEP_PER_BOX,
        })
    }

    fn total(&self, target: &str) -> usize {
        self.boxes.get(target).map_or(0, |b| b.lines.values().map(VecDeque::len).sum())
    }
}

pub(crate) async fn load(dir: &Path) -> Log {
    let path = dir.join(FILE);
    match tokio::fs::read(&path).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(log) => log,
            Err(e) => {
                let bad = dir.join(format!("{FILE}.bad"));
                log::warn!("{} is not readable ({e}); the error history starts over, the old one is at {}", path.display(), bad.display());
                let _ = tokio::fs::rename(&path, &bad).await;
                Log::default()
            }
        },
        Err(_) => Log::default(),
    }
}

pub(crate) async fn save(log: &Log, dir: &Path) -> anyhow::Result<()> {
    let tmp = dir.join(format!("{FILE}.tmp"));
    tokio::fs::write(&tmp, serde_json::to_vec(log)?).await?;
    tokio::fs::rename(&tmp, dir.join(FILE)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(at: i64, msg: &str) -> Fault {
        Fault { at, code: "500".into(), msg: msg.into(), ms: 1.0 }
    }

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn a_ring_pulled_again_adds_only_what_is_new() {
        let mut log = Log::default();
        let ring = vec![f(NOW - 30, "a"), f(NOW - 20, "b"), f(NOW - 20, "c")];
        assert_eq!(log.merge("box", "k", &ring, NOW), 3);
        assert_eq!(log.merge("box", "k", &ring, NOW), 0);
        let more = vec![f(NOW - 20, "b"), f(NOW - 20, "c"), f(NOW - 20, "d"), f(NOW - 10, "e")];
        assert_eq!(log.merge("box", "k", &more, NOW), 2);
        let rows = log.answer("box", "k", 0)["rows"].as_array().unwrap().iter().map(|r| r["msg"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!(rows, ["e", "d", "c", "b", "a"]);
    }

    #[test]
    fn a_process_restart_keeps_what_was_kept() {
        let mut log = Log::default();
        log.merge("box", "k", &(0..100).map(|i| f(NOW - 1000 + i, "old")).collect::<Vec<_>>(), NOW);
        log.merge("box", "k", &[f(NOW - 5, "after restart")], NOW);
        assert_eq!(log.answer("box", "k", 0)["kept"], 101);
    }

    #[test]
    fn a_line_keeps_its_newest_five_hundred() {
        let mut log = Log::default();
        for round in 0..8 {
            let ring: Vec<Fault> = (0..100).map(|i| f(NOW - 10_000 + round * 100 + i, "x")).collect();
            log.merge("box", "k", &ring, NOW);
        }
        let a = log.answer("box", "k", 0);
        assert_eq!(a["kept"], KEEP_PER_LINE);
        assert_eq!(a["rows"][0]["at"], NOW - 10_000 + 799);
        assert_eq!(a["rows"][KEEP_PER_LINE - 1]["at"], NOW - 10_000 + 300);
    }

    #[test]
    fn the_window_and_the_age_limit_cut_by_time() {
        let mut log = Log::default();
        log.merge("box", "k", &[f(NOW - KEEP_MS - 1, "too old"), f(NOW - 7_200_000, "two hours"), f(NOW - 60_000, "a minute")], NOW);
        assert_eq!(log.answer("box", "k", 0)["kept"], 2);
        assert_eq!(log.answer("box", "k", NOW - 3_600_000)["kept"], 1);
        log.prune(NOW - 3_600_000 + KEEP_MS);
        assert_eq!(log.answer("box", "k", 0)["kept"], 1);
        log.prune(NOW + KEEP_MS);
        assert_eq!(log.total("box"), 0);
        assert_eq!(log.answer("box", "k", 0)["since"], NOW);
    }

    #[test]
    fn a_box_over_its_total_loses_its_oldest_first() {
        let mut log = Log::default();
        for line in 0..50 {
            let ring: Vec<Fault> = (0..KEEP_PER_LINE as i64).map(|i| f(NOW - 1_000_000 + line * 10_000 + i, "x")).collect();
            log.merge("box", &format!("line{line}"), &ring, NOW);
        }
        log.merge("other", "k", &[f(NOW - 1, "y")], NOW);
        log.prune(NOW);
        assert_eq!(log.total("box"), KEEP_PER_BOX);
        assert_eq!(log.total("other"), 1);
        assert_eq!(log.answer("box", "line0", 0)["kept"], 0);
        assert_eq!(log.answer("box", "line49", 0)["kept"], KEEP_PER_LINE);
    }

    #[test]
    fn ties_at_the_cut_still_land_on_the_total() {
        let mut log = Log::default();
        for line in 0..45 {
            log.merge("box", &format!("l{line}"), &vec![f(NOW - 5, "same time"); 1].into_iter().chain((0..499).map(|i| f(NOW - 1000 + i, "x"))).collect::<Vec<_>>(), NOW);
        }
        log.prune(NOW);
        assert_eq!(log.total("box"), KEEP_PER_BOX);
    }

    #[test]
    fn a_box_keeps_when_it_started_keeping() {
        let mut log = Log::default();
        log.keep_boxes(&["a".into(), "b".into()], NOW);
        log.merge("a", "k", &[f(NOW + 5, "x")], NOW + 10);
        log.keep_boxes(&["a".into()], NOW + 20);
        assert_eq!(log.answer("a", "k", 0)["since"], NOW);
        assert!(log.boxes.get("b").is_none());
    }

    #[tokio::test]
    async fn the_file_comes_back_and_a_bad_one_is_set_aside() {
        let dir = std::env::temp_dir().join(format!("fault-log-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let mut log = Log::default();
        log.merge("box", "k", &[f(NOW - 1, "kept")], NOW);
        save(&log, &dir).await.unwrap();
        assert_eq!(load(&dir).await.answer("box", "k", 0)["kept"], 1);
        tokio::fs::write(dir.join(FILE), b"{not json").await.unwrap();
        assert_eq!(load(&dir).await.total("box"), 0);
        assert_eq!(tokio::fs::read(dir.join(format!("{FILE}.bad"))).await.unwrap(), b"{not json");
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
