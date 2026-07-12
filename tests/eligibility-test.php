<?php
function normalize_date($value) {
    $value = trim((string) $value);
    if ($value === '') return '';
    $timestamp = strtotime($value);
    return $timestamp === false ? $value : date('Y-m-d', $timestamp);
}
require_once __DIR__ . '/../scripts/lib/eligibility.php';

function assert_case($condition, $message) {
    if (!$condition) {
        fwrite(STDERR, "FAIL: $message\n");
        exit(1);
    }
}

$recentExpected = date('Y-m-d', strtotime('-5 days'));
$recentDelivery = date('Y-m-d', strtotime('-4 days'));
$late = classify_delivery_eligibility($recentExpected, $recentDelivery, 'DOM.XP');
assert_case($late['classification'] === 'DELIVERED_LATE_ELIGIBLE', 'Xpresspost delivered after guarantee should be eligible.');
assert_case($late['claimEligible'] === true, 'Eligible late delivery should enter the claim queue.');

$undelivered = classify_delivery_eligibility('2020-01-01', '', 'DOM.XP');
assert_case($undelivered['classification'] === 'OVERDUE_IN_TRANSIT', 'Undelivered overdue package must not be treated as a late-delivery refund.');
assert_case($undelivered['claimEligible'] === false, 'Undelivered package must not enter late-delivery claims.');

$regular = classify_delivery_eligibility($recentExpected, $recentDelivery, 'DOM.RP');
assert_case($regular['classification'] === 'DELIVERED_LATE_REVIEW_REQUIRED', 'Regular Parcel must not be auto-claimed.');

$usaExpedited = classify_delivery_eligibility($recentExpected, $recentDelivery, 'USA.EP');
assert_case($usaExpedited['reasonCode'] === 'SERVICE_NOT_GUARANTEED', 'Expedited Parcel USA must not be auto-claimed.');

$unknown = classify_delivery_eligibility($recentExpected, $recentDelivery, '');
assert_case($unknown['reasonCode'] === 'SERVICE_UNKNOWN', 'Missing service code must require manual review.');

$expired = classify_delivery_eligibility('2020-01-01', '2020-01-02', 'DOM.XP');
assert_case($expired['reasonCode'] === 'OUTSIDE_CLAIM_WINDOW', 'Claims outside 30 business days must be blocked.');

$onTime = classify_delivery_eligibility($recentDelivery, $recentDelivery, 'DOM.XP');
assert_case($onTime['classification'] === 'DELIVERED_ON_TIME', 'Same-day delivery should be on time.');

assert_case(service_code_from_name('Xpresspost USA') === 'USA.XP', 'Service-name inference should detect Xpresspost USA.');
assert_case(service_code_from_name('Expedited Parcel') === 'DOM.EP', 'Service-name inference should detect domestic Expedited Parcel.');

echo "Eligibility tests passed.\n";
