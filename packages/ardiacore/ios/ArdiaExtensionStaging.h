#pragma once

#import <Foundation/Foundation.h>

namespace ardia_extensions {

NSString *StagingRoot();

NSDictionary *StageUnpacked(NSString *path);

NSString *PromoteStaged(NSString *staged, NSString *digest, NSString **error);

void DiscardStaged(NSString *staged);

}
