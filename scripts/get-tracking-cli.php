<?php
/**
 * CLI Canada Post tracking checker for the Electron GUI.
 * Emits JSON-lines events to stdout and writes late shipments to data/claims.csv.
 *
 * Delivery detection fix:
 * - Use GetTrackingSummary as the authoritative delivery source.
 * - Use pin-summary.actual-delivery-date / pin-summary.event-description instead of
 *   scanning significant-events first.
 * - Keep the full receiver postal code from tracking.csv because summary may only
 *   return the forward-sortation-area / first 3 characters.
 * - Do not mark "not delivered yet" pins as processed; they must be checked again
 *   on the next run.
 * - v4 developer mode can emit redacted raw SOAP request/response XML.
 */

set_time_limit(0);
ini_set('display_errors', 'stderr');

$root = getenv('APP_ROOT') ?: realpath(dirname(__DIR__));
$dataDir = getenv('DATA_DIR') ?: ($root . DIRECTORY_SEPARATOR . 'data');
$csvFile = getenv('TRACKING_CSV') ?: ($dataDir . DIRECTORY_SEPARATOR . 'tracking.csv');
$claimsFile = getenv('CLAIMS_CSV') ?: ($dataDir . DIRECTORY_SEPARATOR . 'claims.csv');
$processedFile = $dataDir . DIRECTORY_SEPARATOR . 'processed_pins.txt';
$overdueFile = $dataDir . DIRECTORY_SEPARATOR . 'overdue-undelivered.csv';
$reviewFile = $dataDir . DIRECTORY_SEPARATOR . 'eligibility-review.csv';
$trackingSummaryFile = $dataDir . DIRECTORY_SEPARATOR . 'tracking-run-summary.json';
$stopFile = getenv('STOP_FILE') ?: ($dataDir . DIRECTORY_SEPARATOR . 'stop-requested.txt');
$wsdl = $root . DIRECTORY_SEPARATOR . 'wsdl' . DIRECTORY_SEPARATOR . 'track.wsdl';
$userIni = file_exists($root . DIRECTORY_SEPARATOR . 'user.ini')
    ? ($root . DIRECTORY_SEPARATOR . 'user.ini')
    : ($dataDir . DIRECTORY_SEPARATOR . 'user.ini');
$cacert = file_exists($root . DIRECTORY_SEPARATOR . 'cacert.pem')
    ? ($root . DIRECTORY_SEPARATOR . 'cacert.pem')
    : ($dataDir . DIRECTORY_SEPARATOR . 'cacert.pem');
$developerMode = in_array(strtolower((string) getenv('DEVELOPER_MODE')), array('1', 'true', 'yes', 'on'), true);
$trackingRequestIntervalMs = (int) (getenv('TRACKING_REQUEST_INTERVAL_MS') ?: 3100);
if ($trackingRequestIntervalMs < 0) $trackingRequestIntervalMs = 3100;

function emit_event($type, $payload = array()) {
    echo json_encode(array_merge(array('type' => $type), $payload), JSON_UNESCAPED_SLASHES) . PHP_EOL;
    flush();
}

function developer_mode_enabled() {
    return !empty($GLOBALS['developerMode']);
}

function redact_sensitive($text) {
    $text = (string) $text;
    $text = preg_replace('#<(?:[A-Za-z0-9_]+:)?Username[^>]*>.*?</(?:[A-Za-z0-9_]+:)?Username>#Us', '<Username>[REDACTED]</Username>', $text);
    $text = preg_replace('#<(?:[A-Za-z0-9_]+:)?Password[^>]*>.*?</(?:[A-Za-z0-9_]+:)?Password>#Us', '<Password>[REDACTED]</Password>', $text);
    $text = preg_replace('/Authorization:\s*Basic\s+[^\r\n]+/i', 'Authorization: Basic [REDACTED]', $text);
    return $text;
}

function redact_value($value) {
    if (is_array($value)) {
        $out = array();
        foreach ($value as $key => $childValue) $out[$key] = redact_value($childValue);
        return $out;
    }
    if (is_object($value)) {
        $out = new stdClass();
        foreach (get_object_vars($value) as $key => $childValue) $out->{$key} = redact_value($childValue);
        return $out;
    }
    return redact_sensitive((string) $value);
}

function emit_debug_raw($payload) {
    if (!developer_mode_enabled()) return;
    $payload = redact_value($payload);
    emit_event('debug_raw', $payload);
}

function fail_event($message) {
    emit_event('error', array('message' => $message));
    exit(1);
}

function csv_value($row, $index) {
    return isset($row[$index]) ? trim((string) $row[$index]) : '';
}

function normalize_postal_code($value) {
    return strtoupper(preg_replace('/\s+/', '', trim((string) $value)));
}

function normalize_header_name($value) {
    return strtolower(preg_replace('/[^a-z0-9]+/i', '', trim((string) $value)));
}

function detect_tracking_csv_header($row) {
    $map = array();
    foreach ($row as $index => $name) {
        $key = normalize_header_name($name);
        if ($key !== '') $map[$key] = $index;
    }

    $pinKeys = array('trackingpin', 'trackingnumber', 'pin', 'tracking', 'trackingid');
    foreach ($pinKeys as $key) {
        if (array_key_exists($key, $map)) return $map;
    }

    return array();
}

function row_value_by_header($row, $headerMap, $names) {
    foreach ($names as $name) {
        $key = normalize_header_name($name);
        if (array_key_exists($key, $headerMap)) return csv_value($row, $headerMap[$key]);
    }
    return '';
}

function extract_csv_row_fields($row, $headerMap) {
    if (!empty($headerMap)) {
        $pin = row_value_by_header($row, $headerMap, array(
            'Tracking PIN', 'Tracking Number', 'PIN', 'Tracking', 'Tracking ID'
        ));
        $postalCode = row_value_by_header($row, $headerMap, array(
            'Destination Postal Code', 'Destination Postal/Zip Code', 'Receiver Postal Code',
            'Receiver\'s Postal Code', 'Postal Code', 'Postal/Zip Code', 'Destination Postal ID',
            'destination-postal-id'
        ));
        $reference = row_value_by_header($row, $headerMap, array(
            'Reference #', 'Reference Number', 'Reference Number 1', 'Reference',
            'Customer Ref 1', 'Customer Ref #1', 'customer-ref-1', 'Order #', 'Order Number',
            'Customer Request ID', 'Shipment ID'
        ));

        $serviceCode = row_value_by_header($row, $headerMap, array(
            'Service Code', 'Product Code', 'Service', 'Product'
        ));

        return array(
            'pin' => $pin,
            'postalCode' => normalize_postal_code($postalCode),
            'reference' => preg_replace('/^Order\s*#:\s*/i', '', $reference),
            'serviceCode' => strtoupper(trim($serviceCode)),
        );
    }

    $reference = csv_value($row, 30);
    if ($reference === '') {
        $reference = preg_replace('/^Order\s*#:\s*/i', '', csv_value($row, 22));
    }

    return array(
        'pin' => csv_value($row, 16),
        'postalCode' => normalize_postal_code(csv_value($row, 27)),
        'reference' => $reference,
        'serviceCode' => '',
    );
}

function object_value($object, $field, $fallback = '') {
    if (is_object($object) && isset($object->{$field})) {
        return trim((string) $object->{$field});
    }
    return $fallback;
}

function as_array($value) {
    if ($value === null) return array();
    return is_array($value) ? $value : array($value);
}

function normalize_date($value) {
    $value = trim((string) $value);
    if ($value === '') return '';

    $timestamp = strtotime($value);
    if ($timestamp === false) return $value;

    return date('Y-m-d', $timestamp);
}

function is_delivered_description($description) {
    $description = trim((string) $description);
    if ($description === '') return false;

    // Avoid false positives like "not delivered" or "unable to deliver".
    if (preg_match('/\bnot\s+delivered\b|\bunable\s+to\s+deliver\b|\bdelivery\s+attempt\b/i', $description)) {
        return false;
    }

    return (bool) preg_match('/\bdelivered\b|community\s+mailbox|parcel\s+locker|recipient\'?s\s+side\s+door/i', $description);
}

require_once __DIR__ . DIRECTORY_SEPARATOR . 'lib' . DIRECTORY_SEPARATOR . 'eligibility.php';

function first_matching_pin_summary($result, $currentPin) {
    if (!is_object($result) || !isset($result->{'tracking-summary'})) return null;
    $summary = $result->{'tracking-summary'};
    if (!is_object($summary) || !isset($summary->{'pin-summary'})) return null;

    $pinSummaries = as_array($summary->{'pin-summary'});
    if (count($pinSummaries) === 0) return null;

    foreach ($pinSummaries as $pinSummary) {
        if (object_value($pinSummary, 'pin') === $currentPin) return $pinSummary;
    }

    return $pinSummaries[0];
}

function extract_summary_status($result, $currentPin, $csvPostalCode, $csvReference) {
    $pinSummary = first_matching_pin_summary($result, $currentPin);
    if (!$pinSummary) {
        return array('hasData' => false);
    }

    $eventDescription = object_value($pinSummary, 'event-description');
    $actualDeliveryDate = normalize_date(object_value($pinSummary, 'actual-delivery-date'));
    $eventDateTime = object_value($pinSummary, 'event-date-time');
    $eventDate = normalize_date($eventDateTime);

    $deliveryDate = $actualDeliveryDate !== '' ? $actualDeliveryDate : (is_delivered_description($eventDescription) ? $eventDate : '');
    $isDelivered = $deliveryDate !== '' || is_delivered_description($eventDescription);

    return array(
        'hasData' => true,
        'source' => 'summary',
        'pin' => object_value($pinSummary, 'pin', $currentPin),
        // Summary can be partial. CSV full postal code is preferred for claim submission.
        'postalId' => $csvPostalCode !== '' ? $csvPostalCode : normalize_postal_code(object_value($pinSummary, 'destination-postal-id')),
        'expectedDate' => normalize_date(object_value($pinSummary, 'expected-delivery-date')),
        'deliveryDate' => $deliveryDate,
        'customerRef' => $csvReference !== '' ? $csvReference : object_value($pinSummary, 'customer-ref-1'),
        'deliveryStatus' => $isDelivered ? ($eventDescription !== '' ? $eventDescription : 'Delivered') : '',
        'eventDescription' => $eventDescription,
        'serviceName' => object_value($pinSummary, 'service-name')
    );
}

function extract_detail_status($result, $currentPin, $csvPostalCode, $csvReference) {
    if (!is_object($result) || !isset($result->{'tracking-detail'})) {
        return array('hasData' => false);
    }

    $detail = $result->{'tracking-detail'};
    $deliveryStatus = '';
    $deliveryDate = '';

    if (isset($detail->{'significant-events'}->occurrence)) {
        $events = as_array($detail->{'significant-events'}->occurrence);

        foreach ($events as $event) {
            $eventDescription = object_value($event, 'event-description');
            if (is_delivered_description($eventDescription)) {
                $deliveryStatus = $eventDescription !== '' ? $eventDescription : 'Delivered';
                $deliveryDate = normalize_date(object_value($event, 'event-date'));
                break;
            }
        }
    }

    return array(
        'hasData' => true,
        'source' => 'detail-fallback',
        'pin' => object_value($detail, 'pin', $currentPin),
        'postalId' => $csvPostalCode !== '' ? $csvPostalCode : normalize_postal_code(object_value($detail, 'destination-postal-id')),
        'expectedDate' => normalize_date(object_value($detail, 'expected-delivery-date')),
        'deliveryDate' => $deliveryDate,
        'customerRef' => $csvReference !== '' ? $csvReference : object_value($detail, 'customer-ref-1'),
        'deliveryStatus' => $deliveryStatus,
        'eventDescription' => $deliveryStatus,
        'serviceName' => object_value($detail, 'service-name')
    );
}

function mark_processed($processedHandle, &$processedPins, $pin) {
    $pin = trim((string) $pin);
    if ($pin === '' || isset($processedPins[$pin])) return;

    if ($processedHandle !== false) {
        fwrite($processedHandle, $pin . PHP_EOL);
        fflush($processedHandle);
    }
    $processedPins[$pin] = true;
}

function waitForFixedRequestInterval(&$lastRequestAt, $intervalMs) {
    $intervalMs = max(0, (int) $intervalMs);
    if ($intervalMs <= 0 || $lastRequestAt <= 0) return;

    $intervalSeconds = $intervalMs / 1000.0;
    $elapsedSeconds = microtime(true) - $lastRequestAt;
    $waitSeconds = $intervalSeconds - $elapsedSeconds;
    if ($waitSeconds > 0) {
        usleep((int) round($waitSeconds * 1000000));
    }
}

function throttleForRateLimit(&$callTimestamps, $rateLimitCalls, $rateLimitWindow) {
    $now = microtime(true);
    $callTimestamps = array_values(array_filter($callTimestamps, function ($ts) use ($now, $rateLimitWindow) {
        return ($now - $ts) < $rateLimitWindow;
    }));

    if (count($callTimestamps) >= $rateLimitCalls) {
        $oldest = $callTimestamps[0];
        $waitSeconds = $rateLimitWindow - ($now - $oldest) + 0.5;
        if ($waitSeconds > 0) {
            emit_event('rate_limit_wait', array('seconds' => round($waitSeconds, 1)));
            usleep((int) round($waitSeconds * 1000000));
        }
    }
}

function soap_call_with_rate_limit($client, $operation, $requestElementName, $requestBody, &$callTimestamps, $rateLimitCalls, $rateLimitWindow, &$lastRequestAt, $requestIntervalMs) {
    waitForFixedRequestInterval($lastRequestAt, $requestIntervalMs);
    throttleForRateLimit($callTimestamps, $rateLimitCalls, $rateLimitWindow);
    $requestStartedAt = microtime(true);
    $callTimestamps[] = $requestStartedAt;
    $lastRequestAt = $requestStartedAt;

    emit_debug_raw(array(
        'label' => 'SOAP request body',
        'operation' => $operation,
        'requestBody' => array($requestElementName => $requestBody),
    ));

    // Important for this Canada Post WSDL:
    // Pass the request element as the top-level SOAP parameter exactly like the
    // original working GetTrackingDetail call. Wrapping this again as array($payload)
    // serializes an empty <get-tracking-summary-request/> body and Canada Post rejects it.
    try {
        $result = $client->__soapCall($operation, array(
            $requestElementName => $requestBody
        ), NULL, NULL);

        emit_debug_raw(array(
            'label' => 'SOAP response',
            'operation' => $operation,
            'requestXml' => method_exists($client, '__getLastRequest') ? $client->__getLastRequest() : '',
            'responseXml' => method_exists($client, '__getLastResponse') ? $client->__getLastResponse() : '',
        ));

        return $result;
    } catch (Exception $e) {
        emit_debug_raw(array(
            'label' => 'SOAP fault',
            'operation' => $operation,
            'requestXml' => method_exists($client, '__getLastRequest') ? $client->__getLastRequest() : '',
            'responseXml' => method_exists($client, '__getLastResponse') ? $client->__getLastResponse() : '',
            'error' => $e->getMessage(),
        ));
        throw $e;
    }
}

if (!extension_loaded('soap')) {
    fail_event('PHP SOAP extension is not enabled. Enable extension=soap in /etc/php/php.ini.');
}
if (!file_exists($csvFile)) fail_event("Missing tracking.csv at $csvFile");
if (!file_exists($wsdl)) fail_event("Missing WSDL at $wsdl");
if (!file_exists($cacert)) fail_event("Missing cacert.pem at $cacert");

$userProperties = file_exists($userIni) ? (parse_ini_file($userIni) ?: array()) : array();
$apiUsername = trim((string) (getenv('CANADAPOST_API_USERNAME') ?: ($userProperties['username'] ?? '')));
$apiPassword = (string) (getenv('CANADAPOST_API_PASSWORD') ?: ($userProperties['password'] ?? ''));
if ($apiUsername === '' || $apiPassword === '') {
    fail_event('Missing Canada Post Developer API credentials. Import user.ini through the desktop app so the credentials can be stored securely.');
}

$handle = fopen($csvFile, 'r');
if ($handle === false) fail_event('Could not open tracking.csv.');

$firstRow = fgetcsv($handle, 0, ',');
if ($firstRow === false) fail_event('tracking.csv is empty.');
$headerMap = detect_tracking_csv_header($firstRow);
$hasHeader = !empty($headerMap);
$totalRows = $hasHeader ? 0 : 1;
while (fgetcsv($handle, 0, ',') !== false) $totalRows++;
rewind($handle);

if ($totalRows === 0) fail_event('tracking.csv has a header but no tracking rows.');

$hostName = 'soa-gw.canadapost.ca';
$location = 'https://' . $hostName . '/vis/soap/track';
$opts = array(
    'ssl' => array(
        'verify_peer' => true,
        'verify_peer_name' => true,
        'cafile' => $cacert,
    )
);
$ctx = stream_context_create($opts);

try {
    $client = new SoapClient($wsdl, array(
        'location' => $location,
        'features' => SOAP_SINGLE_ELEMENT_ARRAYS,
        'stream_context' => $ctx,
        'trace' => $developerMode ? 1 : 0
    ));
} catch (Exception $e) {
    fail_event('Could not create SOAP client: ' . $e->getMessage());
}

$WSSENS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
$usernameToken = new stdClass();
$usernameToken->Username = new SoapVar($apiUsername, XSD_STRING, null, null, null, $WSSENS);
$usernameToken->Password = new SoapVar($apiPassword, XSD_STRING, null, null, null, $WSSENS);
$content = new stdClass();
$content->UsernameToken = new SoapVar($usernameToken, SOAP_ENC_OBJECT, null, null, null, $WSSENS);
$header = new SOAPHeader($WSSENS, 'Security', $content);
$client->__setSoapHeaders($header);

$processedPins = array();
if (file_exists($processedFile)) {
    $lines = file($processedFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines !== false) $processedPins = array_flip($lines);
}
$processedHandle = fopen($processedFile, 'a');

$isFreshClaims = !file_exists($claimsFile) || filesize($claimsFile) === 0;
$claimsHandle = fopen($claimsFile, $isFreshClaims ? 'w' : 'a');
if ($claimsHandle === false) fail_event('Could not open claims.csv for writing.');
if ($isFreshClaims) {
    fputcsv($claimsHandle, array('Tracking PIN', 'Destination Postal Code', 'Expected Delivery Date', 'Actual Delivery Date', 'Reference #', 'Service Code', 'Status', 'Eligibility Reason'));
}

$existingClaimPins = array();
if (!$isFreshClaims && file_exists($claimsFile)) {
    $existingHandle = fopen($claimsFile, 'r');
    if ($existingHandle !== false) {
        $existingHeader = fgetcsv($existingHandle, 0, ',');
        while (($existingRow = fgetcsv($existingHandle, 0, ',')) !== false) {
            $existingPin = trim((string) ($existingRow[0] ?? ''));
            if ($existingPin !== '') $existingClaimPins[$existingPin] = true;
        }
        fclose($existingHandle);
    }
}

$overdueHandle = fopen($overdueFile, 'w');
$reviewHandle = fopen($reviewFile, 'w');
if ($overdueHandle === false || $reviewHandle === false) fail_event('Could not open eligibility output files.');
fputcsv($overdueHandle, array('Tracking PIN', 'Destination Postal Code', 'Expected Delivery Date', 'Reference #', 'Service Code', 'Classification', 'Reason'));
fputcsv($reviewHandle, array('Tracking PIN', 'Destination Postal Code', 'Expected Delivery Date', 'Actual Delivery Date', 'Reference #', 'Service Code', 'Classification', 'Reason Code', 'Reason'));

emit_event('tracking_start', array('total' => $totalRows, 'trackingCsv' => $csvFile, 'claimsCsv' => $claimsFile, 'overdueCsv' => $overdueFile, 'reviewCsv' => $reviewFile, 'deliverySource' => 'GetTrackingSummary', 'requestIntervalMs' => $trackingRequestIntervalMs));

$callTimestamps = array();
$lastTrackingRequestAt = 0.0;
$rateLimitCalls = 20;
$rateLimitWindow = 60;
$currentRowIndex = 0;
$rawRowIndex = 0;
$lateCount = 0;
$processedCount = 0;
$onTimeCount = 0;
$overdueCount = 0;
$reviewCount = 0;
$inTransitCount = 0;
$noDataCount = 0;
$skippedCount = 0;
$errorCount = 0;

while (($row = fgetcsv($handle, 0, ',')) !== false) {
    $rawRowIndex++;
    if ($hasHeader && $rawRowIndex === 1) continue;
    $currentRowIndex++;

    if (file_exists($stopFile)) {
        emit_event('tracking_stopped', array('current' => $currentRowIndex, 'total' => $totalRows));
        break;
    }

    $csvFields = extract_csv_row_fields($row, $headerMap);
    if (trim($csvFields['pin']) === '') {
        emit_event('tracking_progress', array('current' => $currentRowIndex, 'total' => $totalRows));
        continue;
    }

    $currentPin = trim($csvFields['pin']);
    $csvPostalCode = normalize_postal_code($csvFields['postalCode']);
    $csvReference = trim((string) $csvFields['reference']);
    $serviceCode = strtoupper(trim((string) ($csvFields['serviceCode'] ?? '')));

    if (isset($processedPins[$currentPin])) {
        $skippedCount++;
        emit_event('pin_skipped', array('pin' => $currentPin, 'row' => $currentRowIndex));
        emit_event('tracking_progress', array('current' => $currentRowIndex, 'total' => $totalRows));
        continue;
    }

    $attempts = 0;
    $maxAttempts = 3;
    $requestSuccess = false;

    while ($attempts < $maxAttempts && !$requestSuccess) {
        try {
            $summaryResult = soap_call_with_rate_limit($client, 'GetTrackingSummary', 'get-tracking-summary-request', array(
                'locale' => 'EN',
                'pin' => $currentPin
            ), $callTimestamps, $rateLimitCalls, $rateLimitWindow, $lastTrackingRequestAt, $trackingRequestIntervalMs);

            $status = extract_summary_status($summaryResult, $currentPin, $csvPostalCode, $csvReference);

            // Summary is authoritative. Detail is used only when summary has no pin-summary.
            if (empty($status['hasData'])) {
                $detailResult = soap_call_with_rate_limit($client, 'GetTrackingDetail', 'get-tracking-detail-request', array(
                    'locale' => 'EN',
                    'pin' => $currentPin
                ), $callTimestamps, $rateLimitCalls, $rateLimitWindow, $lastTrackingRequestAt, $trackingRequestIntervalMs);
                $status = extract_detail_status($detailResult, $currentPin, $csvPostalCode, $csvReference);
            }

            $requestSuccess = true;
            $processedCount++;

            if (empty($status['hasData'])) {
                $noDataCount++;
                emit_event('pin_no_data', array('pin' => $currentPin, 'row' => $currentRowIndex, 'expectedDate' => '', 'deliveryDate' => '', 'deliverySource' => 'none'));
                break;
            }

            $pin = $status['pin'] ?: $currentPin;
            $postalId = $status['postalId'] ?: $csvPostalCode;
            $expectedDate = $status['expectedDate'];
            $deliveryDate = $status['deliveryDate'];
            $customerRef = $status['customerRef'] ?: $csvReference;
            $deliveryStatus = $status['deliveryStatus'];
            $deliverySource = $status['source'];
            $eventDescription = $status['eventDescription'];
            $serviceName = trim((string) ($status['serviceName'] ?? ''));
            if ($serviceCode === '') $serviceCode = service_code_from_name($serviceName);

            $eligibility = classify_delivery_eligibility($expectedDate, $deliveryDate, $serviceCode);
            $classification = $eligibility['classification'];

            if ($classification === 'DELIVERED_LATE_ELIGIBLE') {
                $lateCount++;
                if (!isset($existingClaimPins[$pin])) {
                    fputcsv($claimsHandle, array(
                        $pin,
                        $postalId,
                        $expectedDate,
                        $deliveryDate,
                        $customerRef,
                        $serviceCode,
                        'ELIGIBLE - DELIVERED LATE',
                        $eligibility['reason']
                    ));
                    fflush($claimsHandle);
                    $existingClaimPins[$pin] = true;
                }
                mark_processed($processedHandle, $processedPins, $currentPin);
                emit_event('pin_late', array(
                    'pin' => $pin,
                    'row' => $currentRowIndex,
                    'postalCode' => $postalId,
                    'reference' => $customerRef,
                    'serviceCode' => $serviceCode,
                    'expectedDate' => $expectedDate,
                    'deliveryDate' => $deliveryDate,
                    'deliverySource' => $deliverySource,
                    'eventDescription' => $eventDescription,
                    'classification' => $classification,
                    'eligibilityReason' => $eligibility['reason']
                ));
            } elseif ($classification === 'DELIVERED_ON_TIME') {
                $onTimeCount++;
                mark_processed($processedHandle, $processedPins, $currentPin);
                emit_event('pin_on_time', array(
                    'pin' => $pin,
                    'row' => $currentRowIndex,
                    'serviceCode' => $serviceCode,
                    'expectedDate' => $expectedDate,
                    'deliveryDate' => $deliveryDate,
                    'deliverySource' => $deliverySource,
                    'eventDescription' => $eventDescription,
                    'classification' => $classification
                ));
            } elseif ($classification === 'OVERDUE_IN_TRANSIT') {
                $overdueCount++;
                fputcsv($overdueHandle, array($pin, $postalId, $expectedDate, $customerRef, $serviceCode, $classification, $eligibility['reason']));
                fflush($overdueHandle);
                emit_event('pin_overdue_in_transit', array(
                    'pin' => $pin,
                    'row' => $currentRowIndex,
                    'postalCode' => $postalId,
                    'reference' => $customerRef,
                    'serviceCode' => $serviceCode,
                    'expectedDate' => $expectedDate,
                    'deliveryDate' => '',
                    'deliverySource' => $deliverySource,
                    'eventDescription' => $eventDescription,
                    'classification' => $classification,
                    'eligibilityReason' => $eligibility['reason']
                ));
            } elseif ($classification === 'IN_TRANSIT') {
                $inTransitCount++;
                emit_event('pin_not_delivered', array(
                    'pin' => $pin,
                    'row' => $currentRowIndex,
                    'postalCode' => $postalId,
                    'reference' => $customerRef,
                    'serviceCode' => $serviceCode,
                    'expectedDate' => $expectedDate,
                    'deliveryDate' => '',
                    'deliverySource' => $deliverySource,
                    'eventDescription' => $eventDescription,
                    'classification' => $classification
                ));
            } else {
                $reviewCount++;
                fputcsv($reviewHandle, array($pin, $postalId, $expectedDate, $deliveryDate, $customerRef, $serviceCode, $classification, $eligibility['reasonCode'], $eligibility['reason']));
                fflush($reviewHandle);
                emit_event('pin_review_required', array(
                    'pin' => $pin,
                    'row' => $currentRowIndex,
                    'postalCode' => $postalId,
                    'reference' => $customerRef,
                    'serviceCode' => $serviceCode,
                    'expectedDate' => $expectedDate,
                    'deliveryDate' => $deliveryDate,
                    'deliverySource' => $deliverySource,
                    'eventDescription' => $eventDescription,
                    'classification' => $classification,
                    'reasonCode' => $eligibility['reasonCode'],
                    'eligibilityReason' => $eligibility['reason']
                ));
            }



        } catch (SoapFault $exception) {
            $faultReason = trim($exception->getMessage());
            if (stripos($faultReason, 'Rejected by SLM Monitor') !== false) {
                $attempts++;
                emit_event('rate_limit_backoff', array('pin' => $currentPin, 'attempt' => $attempts, 'maxAttempts' => $maxAttempts));
                sleep(15);
            } else {
                $errorCount++;
                emit_event('pin_error', array('pin' => $currentPin, 'row' => $currentRowIndex, 'message' => $faultReason, 'expectedDate' => '', 'deliveryDate' => ''));
                break;
            }
        } catch (Exception $e) {
            $errorCount++;
            emit_event('pin_error', array('pin' => $currentPin, 'row' => $currentRowIndex, 'message' => $e->getMessage(), 'expectedDate' => '', 'deliveryDate' => ''));
            break;
        }
    }

    emit_event('tracking_progress', array('current' => $currentRowIndex, 'total' => $totalRows));
    usleep(100000);
}

fclose($claimsHandle);
fclose($overdueHandle);
fclose($reviewHandle);
if ($processedHandle !== false) fclose($processedHandle);
fclose($handle);

$summary = array(
    'generatedAt' => date(DATE_ATOM),
    'total' => $totalRows,
    'checked' => $processedCount,
    'eligibleLateCount' => $lateCount,
    'onTimeCount' => $onTimeCount,
    'overdueInTransitCount' => $overdueCount,
    'inTransitCount' => $inTransitCount,
    'reviewRequiredCount' => $reviewCount,
    'noDataCount' => $noDataCount,
    'skippedCount' => $skippedCount,
    'errorCount' => $errorCount,
    'claimsCsv' => $claimsFile,
    'overdueCsv' => $overdueFile,
    'reviewCsv' => $reviewFile,
    'deliverySource' => 'GetTrackingSummary',
    'status' => $errorCount > 0 ? 'COMPLETE_WITH_WARNINGS' : 'COMPLETE'
);
file_put_contents($trackingSummaryFile . '.tmp', json_encode($summary, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
rename($trackingSummaryFile . '.tmp', $trackingSummaryFile);
emit_event('tracking_complete', $summary);
