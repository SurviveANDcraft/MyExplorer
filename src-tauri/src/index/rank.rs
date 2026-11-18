//! Ranking: "the file I actually wanted".

use memchr::memmem;

pub const Q_EXACT: f32 = 100.0;
pub const Q_STEM: f32 = 95.0;
pub const Q_PREFIX: f32 = 80.0;
pub const Q_BOUNDARY: f32 = 60.0;
pub const Q_SUBSTRING: f32 = 40.0;
pub const Q_FILTER_ONLY: f32 = 50.0;

#[inline]
fn is_sep(c: u8) -> bool {
    matches!(c, b' ' | b'_' | b'-' | b'.' | b'(' | b')' | b'[' | b']' | b'{' | b'}' | b'+' | b',' | b';' | b'!' | b'@' | b'#' | b'&' | b'\'' | b'~' | b'=')
}

/// Is `pos` a word start in the name? Uses the original-case name for camelCase if byte-aligned with `lower`.
#[inline]
fn is_boundary(lower: &[u8], orig: &[u8], pos: usize) -> bool {
    if pos == 0 {
        return true;
    }
    let prev = lower[pos - 1];
    let cur = lower[pos];
    if is_sep(prev) {
        return true;
    }
    if cur.is_ascii_digit() && !prev.is_ascii_digit() {
        return true;
    }
    if !cur.is_ascii_digit() && prev.is_ascii_digit() && cur.is_ascii_alphabetic() {
        return true;
    }
    if orig.len() == lower.len() {
        let (p, c) = (orig[pos - 1], orig[pos]);
        if p.is_ascii_lowercase() && c.is_ascii_uppercase() {
            return true;
        }
    }
    false
}

/// Match quality of `term` (lowercase) in a name. 0 if not contained.
pub fn term_quality(lower: &[u8], orig: &[u8], term: &[u8]) -> f32 {
    if term.is_empty() {
        return Q_SUBSTRING;
    }
    if lower == term {
        return Q_EXACT;
    }
    if let Some(dot) = memchr::memrchr(b'.', lower) {
        if dot > 0 && &lower[..dot] == term {
            return Q_STEM;
        }
    }
    if lower.starts_with(term) {
        return Q_PREFIX;
    }
    let mut found = false;
    for pos in memmem::find_iter(lower, term) {
        found = true;
        if is_boundary(lower, orig, pos) {
            return Q_BOUNDARY;
        }
    }
    if found { Q_SUBSTRING } else { 0.0 }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Signals {
    /// Average term quality (or Q_FILTER_ONLY).
    pub quality: f32,
    pub name_len: usize,
    /// Sum of matched term lengths.
    pub terms_len: usize,
    pub hidden_or_system: bool,
    /// Age of last modification in ms (negative/unknown treated as old).
    pub age_ms: i64,
    pub frec_file: f32,
    pub frec_dir: f32,
    pub in_profile: bool,
    pub noisy: bool,
}

const DAY: i64 = 86_400_000;

pub fn score(s: &Signals) -> f32 {
    let nl = s.name_len.max(1) as f32;
    let coverage = (s.terms_len as f32 / nl).min(1.0);
    // Base: match quality, coverage of the name by the query, shorter names win.
    let mut sc = s.quality + 25.0 * coverage + 15.0 / (1.0 + nl / 12.0);
    sc *= 1.0 + 0.6 * (1.0 + s.frec_file).ln() + 0.25 * (1.0 + s.frec_dir).ln();
    sc *= if s.age_ms < 0 {
        1.0
    } else if s.age_ms < DAY {
        1.25
    } else if s.age_ms < 7 * DAY {
        1.15
    } else if s.age_ms < 30 * DAY {
        1.07
    } else if s.age_ms < 365 * DAY {
        1.0
    } else {
        0.97
    };
    if s.in_profile {
        sc *= 1.2;
    }
    if s.hidden_or_system {
        sc *= 0.6;
    }
    if s.noisy {
        sc *= 0.35;
    }
    sc
}

const NOISE: &[&[u8]] = &[
    b"node_modules",
    b".git",
    b".svn",
    b".hg",
    b"appdata",
    b"windows",
    b"program files",
    b"program files (x86)",
    b"programdata",
    b"$recycle.bin",
    b"system volume information",
    b"$windows.~bt",
    b"$windows.~ws",
    b"cache",
    b"caches",
    b".cache",
    b"__pycache__",
    b"temp",
    b"tmp",
    b".npm",
    b".pnpm-store",
    b".cargo",
    b".rustup",
    b".gradle",
    b".nuget",
    b".vs",
    b".vscode-server",
    b"winsxs",
    b"msocache",
    b"site-packages",
    b".venv",
    b"venv",
    b"bower_components",
    b".next",
    b".nuxt",
    b".turbo",
];

/// Is this (lowercase) folder name a noise folder?
pub fn is_noise_dir(lower: &[u8]) -> bool {
    NOISE.contains(&lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(name: &str, term: &str) -> f32 {
        term_quality(name.to_lowercase().as_bytes(), name.as_bytes(), term.as_bytes())
    }

    #[test]
    fn quality_order() {
        assert_eq!(q("report", "report"), Q_EXACT);
        assert_eq!(q("Report.pdf", "report"), Q_STEM);
        assert_eq!(q("ReportFinal.pdf", "report"), Q_PREFIX);
        assert_eq!(q("2024_report.pdf", "report"), Q_BOUNDARY);
        assert_eq!(q("myReport.pdf", "report"), Q_BOUNDARY);
        assert_eq!(q("myreport.pdf", "report"), Q_SUBSTRING);
        assert_eq!(q("notes.txt", "report"), 0.0);
        assert_eq!(q("invoice2024.pdf", "2024"), Q_BOUNDARY);
    }

    fn sig(quality: f32, name_len: usize, terms_len: usize) -> Signals {
        Signals { quality, name_len, terms_len, age_ms: 400 * DAY, ..Default::default() }
    }

    #[test]
    fn exact_beats_prefix_beats_substring() {
        let exact = score(&sig(Q_STEM, 10, 6));
        let prefix = score(&sig(Q_PREFIX, 15, 6));
        let boundary = score(&sig(Q_BOUNDARY, 15, 6));
        let sub = score(&sig(Q_SUBSTRING, 15, 6));
        assert!(exact > prefix && prefix > boundary && boundary > sub);
    }

    #[test]
    fn shorter_names_win() {
        assert!(score(&sig(Q_PREFIX, 8, 4)) > score(&sig(Q_PREFIX, 40, 4)));
    }

    #[test]
    fn boosts_and_penalties() {
        let base = sig(Q_PREFIX, 12, 4);
        let b = score(&base);
        assert!(score(&Signals { frec_file: 5.0, ..base }) > b);
        assert!(score(&Signals { frec_dir: 5.0, ..base }) > b);
        assert!(score(&Signals { age_ms: DAY / 2, ..base }) > b);
        assert!(score(&Signals { in_profile: true, ..base }) > b);
        assert!(score(&Signals { hidden_or_system: true, ..base }) < b);
        assert!(score(&Signals { noisy: true, ..base }) < b);
        // A noisy exact match should lose to a clean prefix match in the profile.
        let noisy_exact = Signals { noisy: true, ..sig(Q_STEM, 10, 6) };
        let clean_prefix = Signals { in_profile: true, ..sig(Q_PREFIX, 14, 6) };
        assert!(score(&clean_prefix) > score(&noisy_exact));
        // Frequently used file beats a slightly better unused match.
        let used = Signals { frec_file: 10.0, ..sig(Q_BOUNDARY, 14, 6) };
        assert!(score(&used) > score(&sig(Q_PREFIX, 14, 6)));
    }

    #[test]
    fn noise_names() {
        assert!(is_noise_dir(b"node_modules"));
        assert!(is_noise_dir(b"appdata"));
        assert!(!is_noise_dir(b"documents"));
    }
}
