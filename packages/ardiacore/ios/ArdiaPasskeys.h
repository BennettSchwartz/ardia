#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@protocol ArdiaPasskeyPage <NSObject>
@property(nonatomic, readonly, copy) NSString *passkeyProfile;
@property(nonatomic, readonly) BOOL passkeyPrivate;
@property(nonatomic, readonly) NSInteger passkeyDocument;
@property(nonatomic, readonly, nullable, copy) NSString *passkeyTopOrigin;
@property(nonatomic, readonly) BOOL passkeyVisible;
- (void)passkeyConfirm:(NSString *)nonce pageId:(NSInteger)pageId done:(void (^)(BOOL stillPending))done;
- (void)passkeyReply:(NSString *)nonce pageId:(NSInteger)pageId reply:(NSDictionary<NSString *, id> *)reply;
- (void)passkeyEmit:(NSString *)name payload:(NSDictionary<NSString *, id> *)payload;
@end

@interface ArdiaPasskeyCoordinator : NSObject
@property(class, nonatomic, readonly) ArdiaPasskeyCoordinator *shared;
- (void)request:(NSString *)op
        options:(NSString *)optionsJSON
          nonce:(NSString *)nonce
         pageId:(NSInteger)pageId
         origin:(nullable NSString *)origin
           main:(BOOL)main
           page:(id<ArdiaPasskeyPage>)page;
- (void)cancel:(NSString *)nonce pageId:(NSInteger)pageId page:(id<ArdiaPasskeyPage>)page;
- (void)pageChanged:(id<ArdiaPasskeyPage>)page;
- (BOOL)providesForProfile:(NSString *)profile;
@end

NS_ASSUME_NONNULL_END
