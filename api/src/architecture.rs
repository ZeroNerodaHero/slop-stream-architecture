use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent::{Container, Sample};

const MAP: &str = include_str!("architecture.json");
const INTERNET: &str = "(internet)";
const DOCKER: &str = "(docker)";
const DEFAULT_TIER: u8 = 2;

#[derive(Deserialize)]
struct Map {
    tiers: BTreeMap<String, u8>,
    edges: Vec<MapEdge>,
}

#[derive(Deserialize)]
struct MapEdge {
    from: String,
    to: String,
    port: Option<u16>,
    what: String,
}

static STATIC: LazyLock<Map> = LazyLock::new(|| serde_json::from_str(MAP).expect("api/src/architecture.json reads"));

#[derive(Serialize, Debug, PartialEq)]
struct Edge {
    from: String,
    to: String,
    port: Option<u16>,
    proto: Option<String>,
    what: String,
    via: &'static str,
    shared: Option<bool>,
    over: Vec<String>,
}

fn outside(id: &str) -> bool {
    id == INTERNET || id == DOCKER
}

fn tier(map: &Map, c: &Container) -> u8 {
    map.tiers.get(&c.name).or_else(|| c.service.as_ref().and_then(|s| map.tiers.get(s))).copied().unwrap_or(DEFAULT_TIER)
}

fn find<'a>(cs: &'a [Container], want: &str) -> Option<&'a Container> {
    cs.iter().find(|c| c.name == want).or_else(|| cs.iter().find(|c| c.service.as_deref() == Some(want)))
}

fn link(from: &Container, to: &Container, port: Option<u16>, what: String, via: &'static str) -> Edge {
    let a: BTreeSet<&String> = from.networks.iter().collect();
    let over: Vec<String> = to.networks.iter().filter(|n| a.contains(n)).cloned().collect();
    let known = !from.networks.is_empty() && !to.networks.is_empty();
    Edge { from: from.name.clone(), to: to.name.clone(), port, proto: None, what, via, shared: known.then_some(!over.is_empty()), over }
}

pub(crate) fn graph(s: &Sample) -> Value {
    let map: &Map = &STATIC;
    let cs = &s.containers;
    let mut edges: Vec<Edge> = vec![];
    let mut used: BTreeSet<&str> = BTreeSet::new();
    for e in &map.edges {
        let (from, to) = (find(cs, &e.from), find(cs, &e.to));
        let edge = match (from, to) {
            (Some(a), Some(b)) => link(a, b, e.port, e.what.clone(), "map"),
            (Some(a), None) if outside(&e.to) => Edge { from: a.name.clone(), to: e.to.clone(), port: e.port, proto: None, what: e.what.clone(), via: "map", shared: None, over: vec![] },
            (None, Some(b)) if outside(&e.from) => Edge { from: e.from.clone(), to: b.name.clone(), port: e.port, proto: None, what: e.what.clone(), via: "map", shared: None, over: vec![] },
            _ => continue,
        };
        edges.push(edge);
    }
    for c in cs {
        for dep in &c.depends_on {
            let Some(d) = cs.iter().find(|d| d.service.as_deref() == Some(dep.as_str()) && d.project == c.project) else { continue };
            if !edges.iter().any(|e| e.from == c.name && e.to == d.name) {
                edges.push(link(c, d, None, "starts after".into(), "depends_on"));
            }
        }
        for p in c.ports.iter().filter(|p| p.published.is_some() && !p.loopback) {
            edges.push(Edge {
                from: INTERNET.into(),
                to: c.name.clone(),
                port: p.published,
                proto: Some(p.proto.clone()),
                what: format!("published, to {}/{}", p.port, p.proto),
                via: "published",
                shared: None,
                over: vec![],
            });
        }
    }
    for e in &edges {
        for id in [&e.from, &e.to] {
            if outside(id) {
                used.insert(if id == INTERNET { INTERNET } else { DOCKER });
            }
        }
    }
    let mut nodes: Vec<Value> = cs
        .iter()
        .map(|c| {
            json!({
                "id": c.name, "name": c.name, "service": c.service, "project": c.project, "image": c.image,
                "state": c.state, "health": c.health, "exit_code": c.exit_code, "tier": tier(map, c),
                "networks": c.networks, "ports": c.ports, "cpu_pct": c.cpu_pct, "mem_bytes": c.mem_bytes, "mem_limit": c.mem_limit,
                "rx_bps": c.rx_bps, "tx_bps": c.tx_bps, "restarts": c.restarts, "up_since": c.up_since, "outside": false,
            })
        })
        .collect();
    for id in used {
        let name = if id == INTERNET { "internet" } else { "docker engine" };
        nodes.push(json!({ "id": id, "name": name, "tier": map.tiers.get(id).copied().unwrap_or(0), "outside": true }));
    }
    let mut networks: BTreeMap<&String, Vec<&String>> = BTreeMap::new();
    for c in cs {
        for n in &c.networks {
            networks.entry(n).or_default().push(&c.name);
        }
    }
    json!({
        "at": s.at,
        "nodes": nodes,
        "edges": edges,
        "networks": networks.into_iter().map(|(name, members)| json!({ "name": name, "members": members })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::Port;

    fn c(name: &str, service: &str, networks: &[&str], depends_on: &[&str]) -> Container {
        Container {
            name: name.into(),
            service: Some(service.into()),
            project: Some("stream".into()),
            state: "running".into(),
            networks: networks.iter().map(|n| n.to_string()).collect(),
            depends_on: depends_on.iter().map(|n| n.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn the_static_map_reads() {
        assert!(STATIC.edges.len() > 10);
        assert_eq!(STATIC.tiers.get("frontend"), Some(&1));
    }

    #[test]
    fn edges_from_the_map_depends_on_and_published_ports() {
        let mut front = c("frontend", "frontend", &["stream_default", "stream_stats"], &["api"]);
        front.ports = vec![
            Port { port: 443, proto: "tcp".into(), published: Some(443), loopback: false },
            Port { port: 3002, proto: "tcp".into(), published: Some(3002), loopback: true },
        ];
        let mut cs = vec![
            front,
            c("api", "api", &["stream_default"], &["database", "redis"]),
            c("database", "database", &["stream_default"], &[]),
            c("redis", "redis", &["stream_default"], &[]),
            c("agent", "agent", &["stream_default"], &[]),
            c("monitor-test", "monitor", &["monitor-test_default"], &[]),
        ];
        cs[5].project = Some("monitor-test".into());
        let s = Sample { containers: cs, ..Default::default() };
        let g = graph(&s);
        let edges: Vec<(String, String, String)> = g["edges"].as_array().unwrap().iter().map(|e| (e["from"].as_str().unwrap().into(), e["to"].as_str().unwrap().into(), e["via"].as_str().unwrap().into())).collect();
        let has = |f: &str, t: &str, via: &str| edges.contains(&(f.into(), t.into(), via.into()));
        assert!(has("frontend", "api", "map"));
        assert!(!has("frontend", "api", "depends_on"), "a depends_on that the map already draws is not drawn twice");
        assert!(has("api", "database", "map"));
        assert!(has("agent", "(docker)", "map"));
        assert!(has("(internet)", "frontend", "published"));
        assert_eq!(edges.iter().filter(|e| e.0 == "(internet)").count(), 1, "a loopback port is not from the internet");
        let mon = g["edges"].as_array().unwrap().iter().find(|e| e["from"] == "monitor-test").unwrap();
        assert_eq!((mon["to"].as_str(), mon["shared"].as_bool()), (Some("frontend"), Some(false)));
        let api_db = g["edges"].as_array().unwrap().iter().find(|e| e["from"] == "api" && e["to"] == "database").unwrap();
        assert_eq!((api_db["shared"].as_bool(), api_db["port"].as_u64()), (Some(true), Some(5432)));
        assert!(g["nodes"].as_array().unwrap().iter().any(|n| n["id"] == "(docker)" && n["outside"] == true));
        assert_eq!(g["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "monitor-test").unwrap()["tier"], 2);
        let stats = g["networks"].as_array().unwrap().iter().find(|n| n["name"] == "stream_stats").unwrap();
        assert_eq!(stats["members"], json!(["frontend"]));
    }

    #[test]
    fn depends_on_fills_what_the_map_does_not_know() {
        let s = Sample { containers: vec![c("worker", "worker", &["x"], &["queue"]), c("queue", "queue", &["x"], &[])], ..Default::default() };
        let g = graph(&s);
        let e = &g["edges"][0];
        assert_eq!((e["from"].as_str(), e["to"].as_str(), e["via"].as_str(), e["shared"].as_bool()), (Some("worker"), Some("queue"), Some("depends_on"), Some(true)));
    }
}
