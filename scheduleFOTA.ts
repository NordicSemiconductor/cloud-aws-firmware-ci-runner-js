import {
	CreateJobCommand,
	DescribeThingCommand,
	IoTClient,
} from '@aws-sdk/client-iot'
import { IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane'
import { log } from '@nordicsemiconductor/firmware-ci-device-helpers'
import { promises as fs } from 'fs'
import { v4 } from 'uuid'

export const schedulaFOTA = async ({
	deviceId,
	iot,
	fotaFile,
	fotaFileName,
	region,
	bucketName,
	appVersion,
}: {
	deviceId: string
	iot: IoTClient
	iotData: IoTDataPlaneClient
	fotaFile: string
	fotaFileName: string
	region: string
	bucketName: string
	appVersion: string
}): Promise<string> => {
	const { progress } = log({ prefixes: ['FOTA', deviceId] })

	const { thingArn } = await iot.send(
		new DescribeThingCommand({
			thingName: deviceId,
		}),
	)
	if (thingArn === undefined)
		throw new Error(`Failed to describe thing ${deviceId}!`)

	const stat = await fs.stat(fotaFile)
	const fotaJobDocument = {
		operation: 'app_fw_update',
		size: stat.size,
		filename: fotaFileName,
		location: {
			protocol: 'https',
			host: `${bucketName}.s3-${region}.amazonaws.com`,
			path: fotaFileName,
		},
		fwversion: `${appVersion}-upgraded`,
		targetBoard: '9160DK',
	}
	const jobId = v4()
	await iot.send(
		new CreateJobCommand({
			jobId,
			targets: [thingArn],
			document: JSON.stringify(fotaJobDocument),
			description: `Upgrade ${
				thingArn.split('/')[1]
			} to version ${appVersion}-upgraded.`,
			targetSelection: 'SNAPSHOT',
		}),
	)
	progress(`FOTA job "${jobId}" created.`)
	return jobId
}
