//! Search query parser.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Folder,
    File,
    Image,
    Video,
    Audio,
    Doc,
    Code,
    Archive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Period {
    Today,
    Week,
    Month,
    Year,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Query {
    /// Lowercase name terms (all must match the file name).
    pub terms: Vec<String>,
    /// Lowercase path terms (contain '\'), matched against the full path.
    pub path_terms: Vec<String>,
    pub exts: Vec<String>,
    pub kind: Option<Kind>,
    pub size_min: Option<u64>,
    pub size_max: Option<u64>,
    pub modified: Option<Period>,
}

impl Query {
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
            && self.path_terms.is_empty()
            && self.exts.is_empty()
            && self.kind.is_none()
            && self.size_min.is_none()
            && self.size_max.is_none()
            && self.modified.is_none()
    }

    /// Terms for highlighting in names.
    pub fn highlight_terms(&self) -> Vec<String> {
        let mut v = self.terms.clone();
        for p in &self.path_terms {
            if let Some(last) = p.rsplit('\\').next() {
                if !last.is_empty() && !v.iter().any(|t| t == last) {
                    v.push(last.to_string());
                }
            }
        }
        v
    }

    /// Kind → extension set (None for folder/file kinds).
    pub fn kind_exts(&self) -> Option<&'static [&'static str]> {
        Some(match self.kind? {
            Kind::Image => &[
                "jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif", "tif", "tiff", "svg", "ico", "raw", "cr2",
                "cr3", "nef", "arw", "dng", "avif", "jxl", "psd", "jfif",
            ],
            Kind::Video => &[
                "mp4", "mkv", "mov", "avi", "wmv", "webm", "m4v", "flv", "mpg", "mpeg", "3gp", "ts", "m2ts", "mts",
                "vob", "ogv",
            ],
            Kind::Audio => &[
                "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus", "aiff", "aif", "alac", "mid", "midi",
            ],
            Kind::Doc => &[
                "pdf", "doc", "docx", "xls", "xlsx", "xlsm", "ppt", "pptx", "odt", "ods", "odp", "rtf", "txt", "md",
                "csv", "epub", "pages", "key", "numbers", "one", "xps",
            ],
            Kind::Code => &[
                "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "c", "cpp", "cc", "cxx", "h", "hpp", "cs",
                "go", "rb", "php", "swift", "kt", "kts", "scala", "lua", "sh", "ps1", "psm1", "bat", "cmd", "sql",
                "html", "htm", "css", "scss", "less", "json", "yaml", "yml", "toml", "xml", "vue", "svelte", "dart",
                "r", "m", "mm", "zig", "ini", "cfg", "gradle", "sln", "csproj", "vcxproj", "fs", "ex", "exs", "hs",
            ],
            Kind::Archive => &[
                "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab", "iso", "lz", "lzma", "wim", "img",
            ],
            Kind::Folder | Kind::File => return None,
        })
    }
}

fn tokenize(q: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut quoted = false;
    for ch in q.chars() {
        if ch == '"' {
            if in_q {
                if !cur.is_empty() {
                    out.push((std::mem::take(&mut cur), true));
                }
                in_q = false;
                quoted = false;
            } else {
                if !cur.is_empty() {
                    out.push((std::mem::take(&mut cur), quoted));
                }
                in_q = true;
                quoted = true;
            }
        } else if ch.is_whitespace() && !in_q {
            if !cur.is_empty() {
                out.push((std::mem::take(&mut cur), quoted));
            }
        } else {
            cur.push(ch);
        }
    }
    if !cur.is_empty() {
        out.push((cur, quoted));
    }
    out
}

pub fn parse_size(v: &str) -> Option<u64> {
    let v = v.trim().to_lowercase();
    let split = v.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(v.len());
    let (num, unit) = v.split_at(split);
    let n: f64 = num.parse().ok()?;
    let mul: f64 = match unit.trim() {
        "" | "b" => 1.0,
        "k" | "kb" | "kib" => 1024.0,
        "m" | "mb" | "mib" => 1024.0 * 1024.0,
        "g" | "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        "t" | "tb" | "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((n * mul).round() as u64)
}

fn push_term(q: &mut Query, t: &str) {
    let t = t.to_lowercase().replace('/', "\\");
    if t.is_empty() {
        return;
    }
    if t.contains('\\') {
        if !q.path_terms.contains(&t) {
            q.path_terms.push(t);
        }
    } else if !q.terms.contains(&t) {
        q.terms.push(t);
    }
}

pub fn parse(input: &str) -> Query {
    let mut q = Query::default();
    for (tok, quoted) in tokenize(input) {
        if quoted {
            push_term(&mut q, &tok);
            continue;
        }
        if let Some(i) = tok.find(':') {
            let key = tok[..i].to_lowercase();
            let val = tok[i + 1..].trim_matches('"').to_lowercase();
            let handled = match key.as_str() {
                "ext" => {
                    for e in val.split([',', ';']) {
                        let e = e.trim().trim_start_matches("*.").trim_start_matches('.');
                        if !e.is_empty() && !q.exts.iter().any(|x| x == e) {
                            q.exts.push(e.to_string());
                        }
                    }
                    true
                }
                "kind" | "type" => {
                    q.kind = match val.as_str() {
                        "folder" | "folders" | "dir" | "directory" => Some(Kind::Folder),
                        "file" | "files" => Some(Kind::File),
                        "image" | "images" | "picture" | "pictures" | "photo" => Some(Kind::Image),
                        "video" | "videos" | "movie" => Some(Kind::Video),
                        "audio" | "music" | "sound" => Some(Kind::Audio),
                        "doc" | "docs" | "document" | "documents" => Some(Kind::Doc),
                        "code" | "source" => Some(Kind::Code),
                        "archive" | "archives" | "zip" => Some(Kind::Archive),
                        _ => q.kind,
                    };
                    true
                }
                "size" => {
                    let (op, rest) = if let Some(r) = val.strip_prefix(">=") {
                        (">=", r)
                    } else if let Some(r) = val.strip_prefix("<=") {
                        ("<=", r)
                    } else if let Some(r) = val.strip_prefix('>') {
                        (">", r)
                    } else if let Some(r) = val.strip_prefix('<') {
                        ("<", r)
                    } else if let Some(r) = val.strip_prefix('=') {
                        ("=", r)
                    } else {
                        (">=", val.as_str())
                    };
                    if let Some(n) = parse_size(rest) {
                        match op {
                            ">" => q.size_min = Some(n.saturating_add(1)),
                            ">=" => q.size_min = Some(n),
                            "<" => q.size_max = Some(n.saturating_sub(1)),
                            "<=" => q.size_max = Some(n),
                            _ => {
                                q.size_min = Some(n);
                                q.size_max = Some(n);
                            }
                        }
                    }
                    true
                }
                "modified" | "date" | "dm" => {
                    q.modified = match val.as_str() {
                        "today" => Some(Period::Today),
                        "week" | "thisweek" => Some(Period::Week),
                        "month" | "thismonth" => Some(Period::Month),
                        "year" | "thisyear" => Some(Period::Year),
                        _ => q.modified,
                    };
                    true
                }
                _ => false,
            };
            if handled {
                continue;
            }
        }
        let t = tok.trim_matches('*');
        push_term(&mut q, t);
    }
    q
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_and_lowercase() {
        let q = parse("Invoice  2024");
        assert_eq!(q.terms, vec!["invoice", "2024"]);
        assert!(q.path_terms.is_empty());
    }

    #[test]
    fn quoted_phrase_literal() {
        let q = parse("\"My Report\" ext:pdf");
        assert_eq!(q.terms, vec!["my report"]);
        assert_eq!(q.exts, vec!["pdf"]);
        let q = parse("\"ext:pdf\"");
        assert_eq!(q.terms, vec!["ext:pdf"]);
        assert!(q.exts.is_empty());
    }

    #[test]
    fn filters() {
        let q = parse("ext:pdf,.DOCX kind:image size:>10mb modified:week");
        assert_eq!(q.exts, vec!["pdf", "docx"]);
        assert_eq!(q.kind, Some(Kind::Image));
        assert_eq!(q.size_min, Some(10 * 1024 * 1024 + 1));
        assert_eq!(q.modified, Some(Period::Week));
        let q = parse("size:<1kb kind:folder modified:today");
        assert_eq!(q.size_max, Some(1023));
        assert_eq!(q.kind, Some(Kind::Folder));
        assert_eq!(q.modified, Some(Period::Today));
        assert!(q.terms.is_empty());
    }

    #[test]
    fn path_terms() {
        let q = parse("src/main rs C:\\Users");
        assert_eq!(q.path_terms, vec!["src\\main", "c:\\users"]);
        assert_eq!(q.terms, vec!["rs"]);
        assert_eq!(q.highlight_terms(), vec!["rs", "main", "users"]);
    }

    #[test]
    fn wildcards_and_unknown_keys() {
        let q = parse("*.pdf foo:bar");
        assert_eq!(q.terms, vec![".pdf", "foo:bar"]);
    }

    #[test]
    fn empty() {
        assert!(parse("   ").is_empty());
        assert!(!parse("kind:file").is_empty());
        assert_eq!(parse_size("1.5kb"), Some(1536));
        assert_eq!(parse_size("10xb"), None);
    }
}
