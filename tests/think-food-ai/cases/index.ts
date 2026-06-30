import type { TestCase } from "../types";
import { variantSplitAllCategoriesCases } from "./32-variant-split-all-categories";
import { englishCases } from "./01-english";
import { romanUrduCases } from "./02-roman-urdu";
import { hinglishCases } from "./03-hinglish";
import { shortFormCases } from "./04-short-form";
import { spellingMistakeCases } from "./05-spelling-mistakes";
import { missingSpacesCases } from "./06-missing-spaces";
import { extraSpacesCases } from "./07-extra-spaces";
import { mixedMenuItemsCases } from "./08-mixed-menu-items";
import { multipleActionsCases } from "./09-multiple-actions";
import { removeAddSameMessageCases } from "./10-remove-add-same-message";
import { replaceItemCases } from "./11-replace-item";
import { checkoutIntentCases } from "./12-checkout-intent";
import { confirmOrderCases } from "./13-confirm-order";
import { cancelOrderCases } from "./14-cancel-order";
import { unavailableItemsCases } from "./15-unavailable-items";
import { copiedMenuPkrCases } from "./16-copied-menu-pkr";
import { customerConfusionCases } from "./17-customer-confusion";
import { angryCustomerCases } from "./18-angry-customer";
import { veryShortMessagesCases } from "./19-very-short-messages";
import { longNaturalMessagesCases } from "./20-long-natural-messages";
import { generatedItemCoverageCases } from "./21-generated-item-coverage";
import { offTopicCases } from "./22-redteam-offtopic";
import { emojiVoiceCases } from "./23-redteam-emoji-voice";
import { contradictionCases } from "./24-redteam-contradictions";
import { interruptsCheckoutCases } from "./25-redteam-interrupts-checkout";
import { hugeTinyOrderCases } from "./26-redteam-huge-tiny-orders";
import { repeatedEditsCases } from "./27-redteam-repeated-edits";
import { fiveActionsCases } from "./28-redteam-five-actions";
import { similarExactItemCases } from "./29-redteam-similar-exact-items";
import { infoStressCases } from "./30-redteam-info-stress";
import { clarificationAndShowIntentCases } from "./31-clarification-and-show-intent";
import { multiProductRealisticCases } from "./36-multi-product-realistic";
import { cartChangeBeforeConfirmationCases } from "./37-cart-change-before-confirmation";
import { fullCheckoutFlowCases } from "./38-full-checkout-flows";
import { negativeSafetyCases } from "./39-negative-safety";

export const ALL_TEST_CASES: TestCase[] = [
  ...clarificationAndShowIntentCases,
  ...generatedItemCoverageCases,
  ...offTopicCases,
  ...emojiVoiceCases,
  ...contradictionCases,
  ...interruptsCheckoutCases,
  ...hugeTinyOrderCases,
  ...repeatedEditsCases,
  ...fiveActionsCases,
  ...similarExactItemCases,
  ...infoStressCases,
  ...englishCases,
  ...romanUrduCases,
  ...hinglishCases,
  ...shortFormCases,
  ...spellingMistakeCases,
  ...missingSpacesCases,
  ...extraSpacesCases,
  ...mixedMenuItemsCases,
  ...multipleActionsCases,
  ...removeAddSameMessageCases,
  ...replaceItemCases,
  ...checkoutIntentCases,
  ...confirmOrderCases,
  ...cancelOrderCases,
  ...unavailableItemsCases,
  ...copiedMenuPkrCases,
  ...customerConfusionCases,
  ...angryCustomerCases,
  ...veryShortMessagesCases,
  ...longNaturalMessagesCases,
  ...variantSplitAllCategoriesCases,
  ...multiProductRealisticCases,
  ...cartChangeBeforeConfirmationCases,
  ...fullCheckoutFlowCases,
  ...negativeSafetyCases,
];
