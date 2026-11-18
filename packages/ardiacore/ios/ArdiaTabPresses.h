#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

NSUInteger ArdiaTabPressBegan(NSString *key);
NSUInteger ArdiaTabPressClaim(NSString *key);
NSUInteger ArdiaTabPressLatestUnclaimed(void);
NSArray<NSNumber *> *ArdiaTabPressesTakeUnclaimed(NSUInteger upTo);
void ArdiaTabSwitchNotePress(NSString *key, NSUInteger press);
NSUInteger ArdiaTabSwitchTakePress(NSString *key);
void ArdiaTabSplitsSet(NSArray<NSString *> *keys);
BOOL ArdiaTabInSplit(NSString *key);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
