#pragma once

#import <Foundation/Foundation.h>

namespace ardia_extensions {

NSString *StagingRoot(NSString *dataDirectory);

NSDictionary *StageUnpacked(NSString *path, NSString *root);

NSString *PromoteStaged(NSString *staged, NSString *digest, NSString *root, NSString **error);

void DiscardStaged(NSString *staged, NSString *root);

}
