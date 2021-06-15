import { log } from '@nordicsemiconductor/firmware-ci-device-helpers'
import {
	IoTDataPlaneClient,
	GetThingShadowCommand,
} from '@aws-sdk/client-iot-data-plane'
import {
	IoTClient,
	DescribeThingCommand,
	CreateJobCommand,
} from '@aws-sdk/client-iot'
import { TextDecoder } from 'util'
import { promises as fs } from 'fs'
import { v4 } from 'uuid'

export const schedulaFOTA = async ({
	deviceId,
	iotData,
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
}): Promise<{ connected: boolean; jobId?: string }> => {
	const { progress, success, error } = log({ prefixes: ['FOTA'] })

	progress(`Checking if device "${deviceId}" has connected ...`)
	try {
		const shadow = await iotData.send(
			new GetThingShadowCommand({
				thingName: deviceId,
			}),
		)
		const { state } = JSON.parse(
			new TextDecoder('utf-8').decode(shadow.payload),
		)
		success('Device has connected.')
		if (state?.reported?.dev === undefined) {
			success('Device has reported device information.')
			return { connected: true }
		}

		// Schedule FOTA job
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
		return { connected: true, jobId }
	} catch (e) {
		error(e.messsage)
		return { connected: false }
	}
}
