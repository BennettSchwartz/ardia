#pragma once

#import <Foundation/Foundation.h>

namespace ardia_extensions {

using WalkHook = void (^)(NSString *relative);

void SetWalkHook(WalkHook hook);

NSString *TreeDigest(NSString *root, NSString *copyTo, NSString **error);

}
