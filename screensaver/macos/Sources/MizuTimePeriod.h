#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, MizuTimePeriod) {
  MizuTimePeriodNight = 0,
  MizuTimePeriodMorning,
  MizuTimePeriodDay,
  MizuTimePeriodEvening,
};

FOUNDATION_EXPORT MizuTimePeriod
MizuTimePeriodForMinuteOfDay(NSInteger minuteOfDay);
FOUNDATION_EXPORT MizuTimePeriod MizuTimePeriodForDate(NSDate *date,
                                                       NSCalendar *calendar);
FOUNDATION_EXPORT NSString *MizuVideoResourceName(MizuTimePeriod period);
FOUNDATION_EXPORT NSString *MizuTimePeriodDescription(MizuTimePeriod period);
