//! The preview cache: `{clipId}-{updatedAt}.mp4`, one version per clip, capped, least recently played out.

use std::fmt::Display;

pub const CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry<I = String> {
    pub clip_id: I,
    pub updated_at: I,
    pub size: u64,
    /// Larger = played more recently.
    pub played: u64,
}

impl<I: Display> Entry<I> {
    pub fn file_name(&self) -> String {
        format!("{}-{}.mp4", self.clip_id, self.updated_at)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Inserted<I> {
    /// Stored; these entries left (older versions of the clip, then the least recently played). Delete their files.
    Stored { removed: Vec<Entry<I>> },
    /// Larger than the whole cache: not stored.
    TooLarge,
}

#[derive(Clone, Debug)]
pub struct Cache<I = String> {
    cap: u64,
    entries: Vec<Entry<I>>,
}

impl<I: PartialEq + Clone> Cache<I> {
    pub fn new(cap: u64) -> Self {
        Cache { cap, entries: Vec::new() }
    }

    pub fn total(&self) -> u64 {
        self.entries.iter().fold(0u64, |t, e| t.saturating_add(e.size))
    }

    pub fn entries(&self) -> &[Entry<I>] {
        &self.entries
    }

    /// Valid while the clip's `updatedAt` matches.
    pub fn is_valid(&self, clip_id: &I, updated_at: &I) -> bool {
        self.entries.iter().any(|e| &e.clip_id == clip_id && &e.updated_at == updated_at)
    }

    /// Plays an entry: it becomes the most recent.
    pub fn touch(&mut self, clip_id: &I, updated_at: &I, now: u64) {
        if let Some(e) = self.entries.iter_mut().find(|e| &e.clip_id == clip_id && &e.updated_at == updated_at) {
            e.played = now;
        }
    }

    pub fn insert(&mut self, entry: Entry<I>) -> Inserted<I> {
        if entry.size > self.cap {
            return Inserted::TooLarge;
        }
        let mut removed = Vec::new();
        let mut kept = Vec::new();
        for e in self.entries.drain(..) {
            if e.clip_id == entry.clip_id {
                removed.push(e);
            } else {
                kept.push(e);
            }
        }
        self.entries = kept;
        while self.total().saturating_add(entry.size) > self.cap {
            let Some(oldest) = (0..self.entries.len()).min_by_key(|&i| self.entries[i].played) else { break };
            removed.push(self.entries.remove(oldest));
        }
        self.entries.push(entry);
        Inserted::Stored { removed }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(clip: &str, ver: &str, size: u64, played: u64) -> Entry {
        Entry { clip_id: clip.into(), updated_at: ver.into(), size, played }
    }

    #[test]
    fn insert_table() {
        // (cap, existing, new, names removed, names left)
        let table = [
            // an older version of the same clip goes
            (100, vec![e("a", "1", 10, 1), e("b", "1", 10, 2)], e("a", "2", 10, 3), vec!["a-1.mp4"], vec!["b-1.mp4", "a-2.mp4"]),
            // over the cap: the least recently played goes first
            (30, vec![e("a", "1", 10, 5), e("b", "1", 10, 1), e("c", "1", 10, 3)], e("d", "1", 15, 9), vec!["b-1.mp4", "c-1.mp4"], vec!["a-1.mp4", "d-1.mp4"]),
            (30, vec![e("a", "1", 10, 5)], e("b", "1", 10, 6), vec![], vec!["a-1.mp4", "b-1.mp4"]),
        ];
        for (cap, existing, new, gone, left) in table {
            let mut c = Cache::new(cap);
            existing.into_iter().for_each(|x| { c.insert(x); });
            let Inserted::Stored { removed } = c.insert(new) else { panic!("stored") };
            assert_eq!(removed.iter().map(Entry::file_name).collect::<Vec<_>>(), gone);
            assert_eq!(c.entries().iter().map(Entry::file_name).collect::<Vec<_>>(), left);
        }
    }

    #[test]
    fn validity_touch_and_oversize() {
        let mut c = Cache::new(CAP_BYTES);
        c.insert(e("a", "1", 10, 1));
        assert!((c.is_valid(&"a".into(), &"1".into()), c.is_valid(&"a".into(), &"2".into())) == (true, false));
        c.touch(&"a".into(), &"1".into(), 7);
        assert_eq!(c.entries()[0].played, 7);
        assert_eq!(c.insert(e("b", "1", CAP_BYTES + 1, 8)), Inserted::TooLarge);
        assert_eq!(c.total(), 10);
    }

    /// Kani cannot hold this `Vec` logic in 4 GB (two bounded attempts ran out of memory), so the
    /// proof is an exhaustive check of every insert sequence of length <= 5 over a small domain
    /// (2 clips x 2 versions x 3 sizes, 3 caps; the code never looks at magnitudes beyond the cap).
    #[test]
    fn every_short_insert_sequence_keeps_the_cap_and_the_new_entry() {
        let choices: Vec<(u8, u8, u64)> = (0..2).flat_map(|c| (0..2).flat_map(move |v| [0u64, 6, 10].map(move |s| (c, v, s)))).collect();
        for cap in [0u64, 10, 15] {
            let mut stack = vec![(Cache::<u8>::new(cap), 0u64)];
            while let Some((cache, played)) = stack.pop() {
                if played == 5 {
                    continue;
                }
                for &(clip_id, updated_at, size) in &choices {
                    let mut next = cache.clone();
                    let kept = match next.insert(Entry { clip_id, updated_at, size, played }) {
                        Inserted::Stored { .. } => true,
                        Inserted::TooLarge => size > cap,
                    };
                    assert!(kept && next.total() <= cap);
                    if size <= cap {
                        assert!(next.is_valid(&clip_id, &updated_at));
                    }
                    stack.push((next, played + 1));
                }
            }
        }
    }
}
