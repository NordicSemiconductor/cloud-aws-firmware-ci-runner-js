import {
	GetThingShadowCommand,
	IoTDataPlaneClient,
} from '@aws-sdk/client-iot-data-plane'
import { log } from '@nordicsemiconductor/firmware-ci-device-helpers'
import { TextDecoder } from 'util'

export const deviceHasConnected = async ({
	deviceId,
	iotData,
}: {
	deviceId: string
	iotData: IoTDataPlaneClient
}): Promise<boolean> => {
	const { progress, success, error } = log({
		prefixes: ['connection', deviceId],
	})

	progress(`Checking if device has connected ...`)
	try {
		const shadow = await iotData.send(
			new GetThingShadowCommand({
				thingName: deviceId,
			}),
		)
		const { state } = JSON.parse(
			new TextDecoder('utf-8').decode(shadow.payload),
		)
		progress('Device has connected.')
		if (state?.reported?.dev === undefined) {
			error('Device has not reported device information, yet.')
			return false
		}
		success('Device has connected and reported device information.')
		return true
	} catch (err) {
		error('Device has not connected.', err)
		return false
	}
}
