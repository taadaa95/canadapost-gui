<?php
function service_code_from_name($serviceName) {
    $name = strtolower(trim((string) $serviceName));
    if ($name === '') return '';
    if (strpos($name, 'priority worldwide') !== false) return 'INT.PW';
    if (strpos($name, 'xpresspost') !== false && strpos($name, 'international') !== false) return 'INT.XP';
    if (strpos($name, 'xpresspost') !== false && (strpos($name, 'usa') !== false || strpos($name, 'u.s') !== false)) return 'USA.XP';
    if (strpos($name, 'expedited parcel') !== false && (strpos($name, 'usa') !== false || strpos($name, 'u.s') !== false)) return 'USA.EP';
    if (strpos($name, 'tracked packet') !== false) return 'USA.TP';
    if (strpos($name, 'regular parcel') !== false) return 'DOM.RP';
    if (strpos($name, 'expedited parcel') !== false) return 'DOM.EP';
    if (strpos($name, 'xpresspost') !== false) return 'DOM.XP';
    if (preg_match('/\bpriority\b/i', $serviceName)) return 'DOM.PC';
    return '';
}

function service_guarantee_status($serviceCode) {
    $serviceCode = strtoupper(trim((string) $serviceCode));
    if ($serviceCode === '') {
        return array('eligible' => false, 'reasonCode' => 'SERVICE_UNKNOWN', 'reason' => 'Service code is missing; manual eligibility review is required.');
    }

    // Canada Post's late-package criteria currently list Priority, Xpresspost,
    // and Expedited Parcel within Canada; and Priority Worldwide, Xpresspost USA,
    // and Xpresspost International outside Canada.
    $guaranteed = array('DOM.EP', 'DOM.XP', 'DOM.XP.CERT', 'DOM.PC', 'USA.XP', 'INT.XP', 'INT.PW');
    if (in_array($serviceCode, $guaranteed, true) || strpos($serviceCode, 'INT.PW.') === 0) {
        return array('eligible' => true, 'reasonCode' => 'SERVICE_GUARANTEED', 'reason' => 'Service is in the configured Canada Post on-time guarantee allowlist.');
    }

    $notGuaranteed = array(
        'DOM.RP', 'DOM.LIB', 'USA.EP', 'USA.TP', 'USA.TP.LVM',
        'USA.SP.AIR', 'USA.SP.SURF', 'INT.SP.AIR', 'INT.SP.SURF',
        'INT.IP.AIR', 'INT.IP.SURF'
    );
    if (in_array($serviceCode, $notGuaranteed, true)) {
        return array('eligible' => false, 'reasonCode' => 'SERVICE_NOT_GUARANTEED', 'reason' => 'The service is not listed by Canada Post as eligible for a late-delivery postage refund.');
    }

    return array('eligible' => false, 'reasonCode' => 'SERVICE_UNRECOGNIZED', 'reason' => 'Service code is not recognized by the eligibility rules; manual review is required.');
}

function add_business_days($date, $days) {
    $timestamp = strtotime(normalize_date($date) . ' 00:00:00');
    if ($timestamp === false) return false;
    $remaining = max(0, (int) $days);
    while ($remaining > 0) {
        $timestamp = strtotime('+1 day', $timestamp);
        $weekday = (int) date('N', $timestamp);
        if ($weekday <= 5) $remaining--;
    }
    return $timestamp;
}

function classify_delivery_eligibility($expectedDate, $deliveryDate, $serviceCode) {
    $expectedDate = normalize_date($expectedDate);
    $deliveryDate = normalize_date($deliveryDate);
    $service = service_guarantee_status($serviceCode);

    if ($expectedDate === '' || strtotime($expectedDate . ' 00:00:00') === false) {
        return array('classification' => 'INSUFFICIENT_DATA', 'claimEligible' => false, 'reasonCode' => 'EXPECTED_DATE_MISSING', 'reason' => 'Expected delivery date is missing or invalid.');
    }

    $expectedTimestamp = strtotime($expectedDate . ' 00:00:00');
    $todayTimestamp = strtotime(date('Y-m-d') . ' 00:00:00');

    if ($deliveryDate === '') {
        if ($todayTimestamp > $expectedTimestamp) {
            return array('classification' => 'OVERDUE_IN_TRANSIT', 'claimEligible' => false, 'reasonCode' => 'NOT_DELIVERED', 'reason' => 'Expected date has passed, but the package is not delivered. Use the missing-package/investigation workflow instead of a late-delivery refund.');
        }
        return array('classification' => 'IN_TRANSIT', 'claimEligible' => false, 'reasonCode' => 'NOT_DUE', 'reason' => 'Package is still in transit and the expected date has not passed.');
    }

    $deliveryTimestamp = strtotime($deliveryDate . ' 00:00:00');
    if ($deliveryTimestamp === false) {
        return array('classification' => 'INSUFFICIENT_DATA', 'claimEligible' => false, 'reasonCode' => 'DELIVERY_DATE_INVALID', 'reason' => 'Actual delivery date is invalid.');
    }

    if ($deliveryTimestamp <= $expectedTimestamp) {
        return array('classification' => 'DELIVERED_ON_TIME', 'claimEligible' => false, 'reasonCode' => 'ON_TIME', 'reason' => 'Actual delivery date did not exceed the expected date.');
    }

    $deadline = add_business_days($expectedDate, 30);
    if ($deadline !== false && $todayTimestamp > $deadline) {
        return array('classification' => 'DELIVERED_LATE_REVIEW_REQUIRED', 'claimEligible' => false, 'reasonCode' => 'OUTSIDE_CLAIM_WINDOW', 'reason' => 'The 30-business-day refund request window after the guaranteed delivery date has passed.');
    }

    if (!$service['eligible']) {
        return array('classification' => 'DELIVERED_LATE_REVIEW_REQUIRED', 'claimEligible' => false, 'reasonCode' => $service['reasonCode'], 'reason' => $service['reason']);
    }

    return array('classification' => 'DELIVERED_LATE_ELIGIBLE', 'claimEligible' => true, 'reasonCode' => 'DELIVERED_AFTER_GUARANTEE', 'reason' => 'Delivered after the expected date, within the 30-business-day request window, using a configured guaranteed service. Canada Post exclusions and contract terms still apply.');
}
