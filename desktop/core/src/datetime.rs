//! A date and time a person picked in separate boxes (year, month, day, hour, minute), checked as
//! a real calendar moment and turned into the ISO text the engine wants. Replaces typing a
//! date by hand: a wrong day of the month or a post time in the future is named, not guessed at.

/// Why the boxes do not make a moment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    /// A box is empty.
    Missing,
    /// A box holds something that is not a number in range, or a day the month does not have.
    Invalid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
}

fn leap(y: i32) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}

fn days_in(y: i32, m: u32) -> u32 {
    match m {
        2 => 28 + u32::from(leap(y)),
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

impl Stamp {
    /// The five boxes as typed (blank means missing). Years 2000 to 2100 only.
    pub fn parse(year: &str, month: &str, day: &str, hour: &str, minute: &str) -> Result<Stamp, Why> {
        let boxes = [year, month, day, hour, minute].map(str::trim);
        if boxes.iter().any(|b| b.is_empty()) {
            return Err(Why::Missing);
        }
        let n: Vec<u32> = boxes.iter().map(|b| b.parse::<u32>().map_err(|_| Why::Invalid)).collect::<Result<_, _>>()?;
        let year = i32::try_from(n[0]).map_err(|_| Why::Invalid)?;
        let ok = (2000..=2100).contains(&year) && (1..=12).contains(&n[1]) && n[2] >= 1 && n[2] <= days_in(year, n[1]) && n[3] < 24 && n[4] < 60;
        ok.then_some(Stamp { year, month: n[1], day: n[2], hour: n[3], minute: n[4] }).ok_or(Why::Invalid)
    }

    /// Seconds since 1970-01-01 00:00 UTC.
    pub fn unix(&self) -> i64 {
        let (y, m, d) = (i64::from(self.year) - i64::from(self.month <= 2), i64::from(self.month), i64::from(self.day));
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        days * 86_400 + i64::from(self.hour) * 3600 + i64::from(self.minute) * 60
    }

    /// `2026-11-14T19:00:00Z`.
    pub fn iso(&self) -> String {
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:00Z", self.year, self.month, self.day, self.hour, self.minute)
    }

    /// The moment `secs` after the epoch, to the minute.
    pub fn from_unix(secs: i64) -> Stamp {
        let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
        Stamp { year, month, day, hour: (rest / 3600) as u32, minute: (rest % 3600 / 60) as u32 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boxes_become_a_calendar_moment_or_say_why_not() {
        let parse = |a: [&str; 5]| Stamp::parse(a[0], a[1], a[2], a[3], a[4]);
        let rows: [([&str; 5], Result<&str, Why>); 8] = [
            (["2026", "11", "14", "19", "5"], Ok("2026-11-14T19:05:00Z")),
            (["2024", "2", "29", "0", "0"], Ok("2024-02-29T00:00:00Z")),
            (["2026", "2", "29", "0", "0"], Err(Why::Invalid)),
            (["2026", "13", "1", "0", "0"], Err(Why::Invalid)),
            (["2026", "4", "31", "0", "0"], Err(Why::Invalid)),
            (["2026", "11", "14", "24", "0"], Err(Why::Invalid)),
            (["2026", "x", "14", "1", "0"], Err(Why::Invalid)),
            (["2026", "", "14", "1", "0"], Err(Why::Missing)),
        ];
        for (boxes, want) in rows {
            assert_eq!(parse(boxes).map(|s| s.iso()), want.map(String::from), "{boxes:?}");
        }
    }

    /// Every day of every year the boxes accept (2000 to 2100), at the edges of the clock, survives
    /// the trip through seconds. Replaces a Kani proof that did not finish in 10 minutes.
    #[test]
    fn every_valid_day_survives_the_trip_through_seconds() {
        for year in 2000..=2100 {
            for month in 1..=12 {
                for day in 1..=days_in(year, month) {
                    for (hour, minute) in [(0, 0), (23, 59), (12, 30)] {
                        let s = Stamp { year, month, day, hour, minute };
                        assert_eq!(Stamp::from_unix(s.unix()), s);
                    }
                }
            }
        }
    }

    #[test]
    fn unix_and_back_agree_across_leap_days_and_the_epoch() {
        for (iso, secs) in [("1970-01-01T00:00:00Z", 0), ("2000-03-01T00:00:00Z", 951_868_800), ("2024-02-29T12:30:00Z", 1_709_209_800), ("2026-11-14T19:00:00Z", 1_794_682_800)] {
            let s = Stamp::from_unix(secs);
            assert_eq!((s.iso().as_str(), s.unix()), (iso, secs));
        }
    }
}
