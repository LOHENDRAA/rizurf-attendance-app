<?php

declare(strict_types=1);

require_once __DIR__ . '/config.php';

// ============================================================================
// GET /openapi.json - OpenAPI 3.x + Rizurf catalogue metadata
// (RIZURF_API_TEMPLATE.md SS-3, SS-23, SS-27). info.version is kept equal to
// /health's version (SS-2).
// ============================================================================

function openapiDocument(): array
{
    $bearer = static fn (array $scopes): array => [['bearerAuth' => $scopes]];

    return [
        'openapi' => '3.0.3',
        'info' => [
            'title' => 'Rizurf Attendance API',
            'description' => 'Records intern attendance (clock in / out with office QR + GPS '
                . 'verification) and handles medical-certificate and leave requests. Interns '
                . 'themselves live in the Intern Database service; this API references them by id.',
            'version' => appVersion(),
            'x-rizurf' => [
                'domain' => 'People Ops',
                'owner' => 'rizurf-people-ops',
                'app_url' => '/',
                'category' => 'Operations',
                'industries' => ['Human Resources', 'Operations'],
                'use_cases' => [
                    'An intern clocks in or out for the day',
                    'An intern submits a medical certificate or leave request',
                    'Showing an intern their attendance history',
                    'Checking whether an intern has clocked in today',
                ],
                'capabilities' => [
                    [
                        'name' => 'Record Attendance',
                        'icon' => '🕑',
                        'description' => 'Clock an intern in and out, with office presence verified by QR code and GPS.',
                        'does' => [
                            'Clock in for the day',
                            'Clock out',
                            'Verify office presence (QR + within 100m)',
                            'Read the intern\'s recent attendance',
                        ],
                        'best_for' => 'Interns recording their own workday from the attendance app.',
                        'endpoints' => ['GET /api/attendance', 'POST /api/attendance'],
                    ],
                    [
                        'name' => 'Manage Leave',
                        'icon' => '📝',
                        'description' => 'Submit and track medical-certificate and leave requests.',
                        'does' => [
                            'Submit an MC or leave request',
                            'List the intern\'s leave requests and their approval status',
                        ],
                        'best_for' => 'Interns requesting time off and tracking whether it was approved.',
                        'endpoints' => ['GET /api/leave', 'POST /api/leave'],
                    ],
                ],
                'workflows' => [
                    [
                        'name' => 'Daily attendance',
                        'steps' => ['POST /api/attendance', 'GET /api/attendance'],
                    ],
                    [
                        'name' => 'Request leave',
                        'steps' => ['POST /api/leave', 'GET /api/leave'],
                    ],
                ],
                'related_services' => ['intern-database'],
            ],
        ],
        'servers' => [['url' => rtrim((string) env('PUBLIC_URL', ''), '/') ?: '/']],
        'components' => [
            'securitySchemes' => [
                'bearerAuth' => ['type' => 'http', 'scheme' => 'bearer', 'bearerFormat' => 'JWT'],
            ],
        ],
        'paths' => [
            '/health' => [
                'get' => [
                    'summary' => 'Liveness and dependency checks for this service.',
                    'responses' => ['200' => ['description' => 'Service status.']],
                    'x-rizurf' => [
                        'name' => 'Health Check',
                        'purpose' => 'Tell whether this service is up and its dependencies reachable',
                        'use_when' => ['Monitoring the service', 'Before routing traffic to it'],
                        'do_not_use_when' => ['You need attendance or leave data - use the /api endpoints'],
                        'inputs' => [],
                        'outputs' => ['status', 'service', 'version', 'checks'],
                        'requires' => [],
                        'related_endpoints' => ['GET /openapi.json'],
                        'tags' => ['health', 'status', 'liveness', 'monitoring', 'uptime'],
                    ],
                ],
            ],
            '/openapi.json' => [
                'get' => [
                    'summary' => 'This OpenAPI document.',
                    'responses' => ['200' => ['description' => 'The API description.']],
                    'x-rizurf' => [
                        'name' => 'API Document',
                        'purpose' => 'Describe every endpoint this service exposes',
                        'use_when' => ['Discovering the API', 'Generating a client'],
                        'do_not_use_when' => ['You need attendance or leave data'],
                        'inputs' => [],
                        'outputs' => ['openapi', 'info', 'paths'],
                        'requires' => [],
                        'related_endpoints' => ['GET /health'],
                        'tags' => ['openapi', 'schema', 'spec', 'discovery', 'docs'],
                    ],
                ],
            ],
            '/api/attendance' => [
                'get' => [
                    'summary' => 'Read an intern\'s recent attendance and today\'s record.',
                    'security' => $bearer(['attendance:read']),
                    'parameters' => [
                        [
                            'name' => 'intern_id', 'in' => 'query', 'required' => false,
                            'schema' => ['type' => 'string', 'format' => 'uuid'],
                            'description' => 'Which intern (Intern Database id). Required for service '
                                . 'callers; browser sessions use the signed-in intern.',
                        ],
                        [
                            'name' => 'intern_ref', 'in' => 'query', 'required' => false,
                            'schema' => ['type' => 'string'],
                            'description' => 'Alternative to intern_id: the INT-#### reference number.',
                        ],
                    ],
                    'responses' => [
                        '200' => ['description' => 'Recent records and today\'s record.'],
                        '401' => ['description' => 'Missing or invalid token.'],
                    ],
                    'x-rizurf' => [
                        'name' => 'Read Attendance',
                        'purpose' => 'See an intern\'s attendance history and whether they are clocked in today',
                        'use_when' => [
                            'Showing an intern their own attendance log',
                            'Checking if an intern has clocked in or out today',
                        ],
                        'do_not_use_when' => [
                            'Recording a clock in or out - use POST /api/attendance',
                            'Fetching intern personal details - use the Intern Database service',
                        ],
                        'inputs' => ['intern_id', 'intern_ref'],
                        'outputs' => ['records', 'today'],
                        'requires' => ['Authenticated caller with attendance:read'],
                        'related_endpoints' => ['POST /api/attendance', 'GET /api/leave'],
                        'tags' => ['attendance', 'clock', 'timesheet', 'history', 'hours', 'log'],
                    ],
                ],
                'post' => [
                    'summary' => 'Clock an intern in or out for today.',
                    'security' => $bearer(['attendance:write']),
                    'requestBody' => [
                        'required' => true,
                        'content' => ['application/json' => ['schema' => [
                            'type' => 'object',
                            'required' => ['action', 'mode'],
                            'properties' => [
                                'action' => ['type' => 'string', 'enum' => ['in', 'out']],
                                'mode' => ['type' => 'string', 'enum' => ['Office', 'Hybrid']],
                                'qrToken' => ['type' => 'string', 'description' => 'Required when mode is Office.'],
                                'latitude' => ['type' => 'number'],
                                'longitude' => ['type' => 'number'],
                                'accuracy' => ['type' => 'number'],
                            ],
                        ]]],
                    ],
                    'responses' => [
                        '200' => ['description' => 'Attendance recorded; returns the updated records.'],
                        '401' => ['description' => 'Missing or invalid token.'],
                        '409' => ['description' => 'Already clocked in / out, or not yet clocked in.'],
                        '422' => ['description' => 'Invalid action/mode, bad QR, or outside the office radius.'],
                    ],
                    'x-rizurf' => [
                        'name' => 'Record Attendance',
                        'purpose' => 'Clock an intern in or out, verifying office presence when applicable',
                        'use_when' => [
                            'An intern starts their workday (action=in)',
                            'An intern finishes their workday (action=out)',
                        ],
                        'do_not_use_when' => [
                            'Only reading attendance - use GET /api/attendance',
                            'Requesting leave - use POST /api/leave',
                        ],
                        'inputs' => ['action', 'mode', 'qrToken', 'latitude', 'longitude', 'accuracy'],
                        'outputs' => ['records', 'today', 'message'],
                        'requires' => [
                            'Authenticated caller with attendance:write',
                            'A valid office QR and a position within 100m when mode is Office',
                        ],
                        'related_endpoints' => ['GET /api/attendance'],
                        'tags' => ['attendance', 'clock in', 'clock out', 'check in', 'punch', 'time'],
                    ],
                ],
            ],
            '/api/leave' => [
                'get' => [
                    'summary' => 'List an intern\'s leave / MC requests.',
                    'security' => $bearer(['leave:read']),
                    'parameters' => [
                        [
                            'name' => 'intern_id', 'in' => 'query', 'required' => false,
                            'schema' => ['type' => 'string', 'format' => 'uuid'],
                            'description' => 'Which intern (Intern Database id). Required for service callers.',
                        ],
                        [
                            'name' => 'intern_ref', 'in' => 'query', 'required' => false,
                            'schema' => ['type' => 'string'],
                        ],
                    ],
                    'responses' => [
                        '200' => ['description' => 'The intern\'s leave requests, newest first.'],
                        '401' => ['description' => 'Missing or invalid token.'],
                    ],
                    'x-rizurf' => [
                        'name' => 'List Leave Requests',
                        'purpose' => 'See an intern\'s leave / MC requests and their approval status',
                        'use_when' => [
                            'Showing an intern the status of their leave requests',
                        ],
                        'do_not_use_when' => [
                            'Submitting a new request - use POST /api/leave',
                        ],
                        'inputs' => ['intern_id', 'intern_ref'],
                        'outputs' => ['requests'],
                        'requires' => ['Authenticated caller with leave:read'],
                        'related_endpoints' => ['POST /api/leave', 'GET /api/attendance'],
                        'tags' => ['leave', 'mc', 'medical certificate', 'time off', 'absence', 'status'],
                    ],
                ],
                'post' => [
                    'summary' => 'Submit a leave / MC request for approval.',
                    'security' => $bearer(['leave:write']),
                    'requestBody' => [
                        'required' => true,
                        'content' => ['application/json' => ['schema' => [
                            'type' => 'object',
                            'required' => ['leaveDate', 'category'],
                            'properties' => [
                                'leaveDate' => ['type' => 'string', 'format' => 'date'],
                                'category' => [
                                    'type' => 'string',
                                    'enum' => ['Medical Leave/MC', 'Emergency Leave', 'University Event'],
                                ],
                                'notes' => ['type' => 'string'],
                                'attachmentName' => ['type' => 'string'],
                            ],
                        ]]],
                    ],
                    'responses' => [
                        '200' => ['description' => 'Request submitted, pending review.'],
                        '401' => ['description' => 'Missing or invalid token.'],
                        '422' => ['description' => 'Invalid date or category.'],
                    ],
                    'x-rizurf' => [
                        'name' => 'Submit Leave Request',
                        'purpose' => 'Record a new leave or medical-certificate request for a supervisor to review',
                        'use_when' => [
                            'An intern needs a day off',
                            'An intern is submitting a medical certificate',
                        ],
                        'do_not_use_when' => [
                            'Checking existing requests - use GET /api/leave',
                            'Recording attendance - use POST /api/attendance',
                        ],
                        'inputs' => ['leaveDate', 'category', 'notes', 'attachmentName'],
                        'outputs' => ['message'],
                        'requires' => ['Authenticated caller with leave:write'],
                        'related_endpoints' => ['GET /api/leave'],
                        'tags' => ['leave', 'mc', 'apply', 'request time off', 'sick', 'absence'],
                    ],
                ],
            ],
        ],
    ];
}

/** Scopes an operation declares, e.g. ['attendance:read']. [] means public. */
function requiredScopes(string $path, string $method): array
{
    $operation = openapiDocument()['paths'][$path][strtolower($method)] ?? null;
    if (!$operation || empty($operation['security'])) {
        return [];
    }
    $scopes = [];
    foreach ($operation['security'] as $requirement) {
        foreach ($requirement as $granted) {
            $scopes = array_merge($scopes, $granted);
        }
    }
    return array_values(array_unique($scopes));
}
