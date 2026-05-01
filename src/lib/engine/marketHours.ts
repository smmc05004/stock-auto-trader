type MarketSession = {
  isOpen: boolean;
  reason?: string;
};

function getSeoulDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  return {
    weekday: parts.find((part) => part.type === "weekday")?.value,
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? 0),
    minute: Number(parts.find((part) => part.type === "minute")?.value ?? 0),
  };
}

export function getKoreanRegularMarketSession(date = new Date()): MarketSession {
  const { weekday, hour, minute } = getSeoulDateParts(date);

  if (weekday === "Sat" || weekday === "Sun") {
    return {
      isOpen: false,
      reason: "Korean regular market is closed on weekends.",
    };
  }

  const minutesFromMidnight = hour * 60 + minute;
  const openMinutes = 9 * 60;
  const closeMinutes = 15 * 60 + 30;

  if (minutesFromMidnight < openMinutes || minutesFromMidnight > closeMinutes) {
    return {
      isOpen: false,
      reason: "Korean regular market is open from 09:00 to 15:30 Asia/Seoul.",
    };
  }

  return {
    isOpen: true,
  };
}
