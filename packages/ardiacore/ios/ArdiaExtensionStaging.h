#pragma once

#import <Foundation/Foundation.h>

namespace ardia_extensions {

NSString *StagingRoot(NSString *dataDirectory);

NSDictionary *StageUnpacked(NSString *path, NSString *profile, NSString *root);

NSString *BeginPromotion(NSString *staged, NSString *digest, NSString *profile, NSString *root, NSString **error);

void FinishPromotion(NSString *live, bool accepted);

void DiscardStaged(NSString *staged, NSString *root);

void RemoveManaged(NSString *live, NSString *profile, NSString *root);

NSDictionary *ManagedInfo(NSString *live, NSString *root);

NSString *IdForPath(NSString *path);

}
