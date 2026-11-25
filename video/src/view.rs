use std::time::{Duration, Instant};

const BURST: u32 = 6;
const REFILL: Duration = Duration::from_secs(1);
pub const MAX_STRIKES: u32 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Full,
    Small,
    Hidden,
}

impl View {
    pub fn parse(text: &str) -> Option<View> {
        match text {
            r#"{"view":"full"}"# => Some(View::Full),
            r#"{"view":"small"}"# => Some(View::Small),
            r#"{"view":"hidden"}"# => Some(View::Hidden),
            _ => None,
        }
    }

    pub fn code(self) -> u8 {
        match self {
            View::Full => 0,
            View::Small => 1,
            View::Hidden => 2,
        }
    }

    pub fn from_code(code: u8) -> View {
        match code {
            1 => View::Small,
            2 => View::Hidden,
            _ => View::Full,
        }
    }
}

#[derive(Debug)]
pub struct Gate {
    tokens: u32,
    refilled: Instant,
    applied: View,
    wanted: View,
}

impl Gate {
    pub fn new(now: Instant) -> Self {
        Self { tokens: BURST, refilled: now, applied: View::Full, wanted: View::Full }
    }

    pub fn wanted(&self) -> View {
        self.wanted
    }

    pub fn want(&mut self, view: View, now: Instant) -> Option<View> {
        self.wanted = view;
        self.tick(now)
    }

    pub fn tick(&mut self, now: Instant) -> Option<View> {
        if self.wanted == self.applied {
            return None;
        }
        self.refill(now);
        if self.tokens == 0 {
            return None;
        }
        self.tokens -= 1;
        self.applied = self.wanted;
        Some(self.applied)
    }

    pub fn due(&self) -> Option<Instant> {
        (self.wanted != self.applied).then(|| self.refilled + REFILL)
    }

    fn refill(&mut self, now: Instant) {
        let earned = (now.saturating_duration_since(self.refilled).as_millis() / REFILL.as_millis()) as u32;
        if earned == 0 {
            return;
        }
        self.tokens = (self.tokens + earned).min(BURST);
        self.refilled = if self.tokens == BURST { now } else { self.refilled + REFILL * earned };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn only_the_three_exact_frames_parse() {
        assert_eq!(View::parse(r#"{"view":"full"}"#), Some(View::Full));
        assert_eq!(View::parse(r#"{"view":"small"}"#), Some(View::Small));
        assert_eq!(View::parse(r#"{"view":"hidden"}"#), Some(View::Hidden));
        for bad in ["", "hidden", r#"{"view":"HIDDEN"}"#, r#"{ "view":"hidden"}"#, r#"{"view":"hidden","x":1}"#, r#"{"view":"top"}"#, r#"{"view":null}"#] {
            assert_eq!(View::parse(bad), None, "{bad}");
        }
        for view in [View::Full, View::Small, View::Hidden] {
            assert_eq!(View::from_code(view.code()), view);
        }
        assert_eq!(View::from_code(99), View::Full);
    }

    #[test]
    fn a_burst_goes_through_and_then_one_change_a_second() {
        let t = Instant::now();
        let mut g = Gate::new(t);
        let mut last = View::Full;
        for _ in 0..BURST {
            last = if last == View::Hidden { View::Full } else { View::Hidden };
            assert_eq!(g.want(last, t), Some(last));
        }
        let next = if last == View::Hidden { View::Full } else { View::Hidden };
        assert_eq!(g.want(next, t + ms(10)), None);
        assert_eq!(g.due(), Some(t + REFILL));
        assert_eq!(g.tick(t + ms(999)), None);
        assert_eq!(g.tick(t + REFILL), Some(next));
        assert_eq!(g.due(), None);
    }

    #[test]
    fn a_held_change_lands_as_the_last_wanted_view() {
        let t = Instant::now();
        let mut g = Gate::new(t);
        let mut last = View::Full;
        for _ in 0..BURST {
            last = if last == View::Small { View::Hidden } else { View::Small };
            g.want(last, t);
        }
        for view in [View::Full, View::Hidden, View::Full, last] {
            g.want(view, t);
        }
        assert_eq!(g.due(), None);
        assert_eq!(g.tick(t + REFILL), None);
        let other = if last == View::Small { View::Hidden } else { View::Small };
        g.want(View::Full, t + REFILL);
        g.want(other, t + REFILL);
        assert_eq!(g.tick(t + REFILL * 2), Some(other));
    }

    #[test]
    fn wanting_what_is_applied_costs_nothing() {
        let t = Instant::now();
        let mut g = Gate::new(t);
        for _ in 0..100 {
            assert_eq!(g.want(View::Full, t), None);
        }
        assert_eq!(g.want(View::Hidden, t), Some(View::Hidden));
        assert_eq!(g.tokens, BURST - 1);
    }

    #[test]
    fn tokens_come_back_but_never_past_the_burst() {
        let t = Instant::now();
        let mut g = Gate::new(t);
        g.want(View::Hidden, t);
        g.want(View::Full, t);
        g.refill(t + Duration::from_secs(600));
        assert_eq!(g.tokens, BURST);
    }
}
