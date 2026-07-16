#import "MizuTimePeriod.h"

static const NSInteger MizuMinutesPerDay = 24 * 60;
static const NSInteger MizuMorningStart = 5 * 60 + 30;
static const NSInteger MizuDayStart = 10 * 60;
static const NSInteger MizuEveningStart = 16 * 60 + 30;
static const NSInteger MizuNightStart = 20 * 60 + 30;

MizuTimePeriod MizuTimePeriodForMinuteOfDay(NSInteger minuteOfDay) {
  NSInteger normalized = minuteOfDay % MizuMinutesPerDay;
  if (normalized < 0) normalized += MizuMinutesPerDay;
  if (normalized < MizuMorningStart || normalized >= MizuNightStart) {
    return MizuTimePeriodNight;
  }
  if (normalized < MizuDayStart) return MizuTimePeriodMorning;
  if (normalized < MizuEveningStart) return MizuTimePeriodDay;
  return MizuTimePeriodEvening;
}

MizuTimePeriod MizuTimePeriodForDate(NSDate *date, NSCalendar *calendar) {
  NSDateComponents *components =
      [calendar components:(NSCalendarUnitHour | NSCalendarUnitMinute)
                   fromDate:date];
  return MizuTimePeriodForMinuteOfDay(components.hour * 60 + components.minute);
}

NSString *MizuVideoResourceName(MizuTimePeriod period) {
  switch (period) {
  case MizuTimePeriodMorning:
    return @"morning";
  case MizuTimePeriodDay:
    return @"day";
  case MizuTimePeriodEvening:
    return @"evening";
  case MizuTimePeriodNight:
    return @"night";
  }
}

NSString *MizuTimePeriodDescription(MizuTimePeriod period) {
  switch (period) {
  case MizuTimePeriodMorning:
    return @"朝";
  case MizuTimePeriodDay:
    return @"昼";
  case MizuTimePeriodEvening:
    return @"夕方";
  case MizuTimePeriodNight:
    return @"夜";
  }
}
