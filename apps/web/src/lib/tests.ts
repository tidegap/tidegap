import { TEST_COUNTS } from "./tests.generated";

export { TEST_COUNTS };

/** Packages whose tests the generated total counts. */
export const TEST_PACKAGE_COUNT = Object.keys(TEST_COUNTS.perPackage).length;
