import {
	flash,
	connect,
	allSeen,
	log,
	runCmd,
	anySeen,
	atHostHexfile,
} from '@nordicsemiconductor/firmware-ci-device-helpers'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as semver from 'semver'
import { schedulaFOTA } from './scheduleFOTA'
import {
	DeleteObjectCommand,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3'
import { IoTClient } from '@aws-sdk/client-iot'
import { IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane'
import { CloudFormationClient } from '@aws-sdk/client-cloudformation'
import { stackOutput } from '@nordicsemiconductor/cloudformation-helpers'
import { deviceHasConnected } from './deviceHasConnected'

const defaultPort = '/dev/ttyACM0'
const defaultSecTag = 42

type Result = {
	connected: boolean
	timeout: boolean
	abort: boolean
	deviceLog: string[]
	flashLog: string[]
}

type Args = {
	deviceId: string
	appVersion: string
	network: 'ltem' | 'nbiot'
	secTag?: number
	timeoutInMinutes: number
	hexFile: string
	fotaFile: string
	abortOn?: string[]
	endOn?: string[]
	endOnWaitSeconds?: number
	testEnv: {
		accessKeyId: string
		secretAccessKey: string
		region: string
		brokerHostname: string
		stackName: string
	}
	certDir: string
	powerCycle?: {
		offCmd: string
		onCmd: string
		waitSecondsAfterOff: number
		waitSecondsAfterOn: number
	}
	flashLogLocation: string
	deviceLogLocation: string
}

// FIXME: implement scheduling FOTA
export const run = ({
	port,
	target,
}: {
	port?: string
	target: 'thingy91_nrf9160ns' | 'nrf9160dk_nrf9160ns'
}): ((args: Args) => Promise<Result>) => {
	const { progress, warn, debug } = log({ withTimestamp: true })
	debug('port', port ?? defaultPort)
	debug('target', target)

	return async ({
		deviceId,
		appVersion,
		network,
		secTag,
		timeoutInMinutes,
		hexFile,
		fotaFile,
		abortOn,
		endOn,
		endOnWaitSeconds,
		testEnv,
		certDir,
		powerCycle,
		flashLogLocation,
		deviceLogLocation,
	}: Args): Promise<Result> => {
		debug('appVersion', appVersion)
		debug('network', network)
		debug('secTag', secTag ?? defaultSecTag)
		debug('timeoutInMinutes', timeoutInMinutes)
		debug('hexFile', hexFile)
		debug('fotaFile', fotaFile)
		debug('abortOn', abortOn)
		debug('endOn', endOn)
		debug('endOn wait seconds', endOnWaitSeconds)
		debug('testEnv', testEnv)
		debug('certDir', certDir)
		debug('powerCycle', powerCycle)
		debug('flashLogLocation', flashLogLocation)
		debug('deviceLogLocation', deviceLogLocation)
		const atHost =
			target === 'thingy91_nrf9160ns'
				? atHostHexfile.thingy91
				: atHostHexfile['9160dk']

		const awsConfig = {
			region: testEnv.region,
			credentials: {
				accessKeyId: testEnv.accessKeyId,
				secretAccessKey: testEnv.secretAccessKey,
			},
		}
		const s3 = new S3Client(awsConfig)
		const iot = new IoTClient(awsConfig)
		const iotData = new IoTDataPlaneClient(awsConfig)
		const { bucketName } = await stackOutput(
			new CloudFormationClient(awsConfig),
		)<{ bucketName: string }>(`${testEnv.stackName}-firmware-ci`)
		const fotaFileName = `${deviceId.substr(0, 8)}.bin`

		if (powerCycle !== undefined) {
			progress(`Power cycling device`)
			progress(`Turning off ...`)
			progress(powerCycle.offCmd)
			await runCmd({ cmd: powerCycle.offCmd })
			progress(`Waiting ${powerCycle.waitSecondsAfterOff} seconds ...`)
			await new Promise((resolve) =>
				setTimeout(resolve, powerCycle.waitSecondsAfterOff * 1000, []),
			)
			progress(`Turning on ...`)
			progress(powerCycle.onCmd)
			await runCmd({ cmd: powerCycle.onCmd })

			progress(`Waiting ${powerCycle.waitSecondsAfterOn} seconds ...`)
			await new Promise((resolve) =>
				setTimeout(resolve, powerCycle.waitSecondsAfterOn * 1000, []),
			)
		}

		// nrfjprog --eraseall
		await runCmd({
			cmd: 'nrfjprog --eraseall',
			...log({ prefixes: ['eraseall'] }),
		})

		let flashLog: string[] = []
		let connected = false

		try {
			const res = await new Promise<Result>((resolve, reject) => {
				let done = false
				let schedulaFotaTimeout: NodeJS.Timeout
				progress(`Connecting to ${port ?? defaultPort}`)
				connect({
					device: port ?? defaultPort,
					atHostHexfile: atHost,
					...log(),
				})
					.then(async ({ connection, deviceLog, onData, onEnd }) => {
						const credentials = JSON.parse(
							await fs.readFile(
								path.resolve(certDir, `device-${deviceId}.json`),
								'utf-8',
							),
						)

						progress(`Setting timeout to ${timeoutInMinutes} minutes`)
						const jobTimeout = setTimeout(async () => {
							done = true
							warn('Timeout reached.')
							await connection.end()
							if (schedulaFotaTimeout !== undefined)
								clearTimeout(schedulaFotaTimeout)
							resolve({
								connected,
								timeout: true,
								abort: false,
								deviceLog,
								flashLog,
							})
						}, timeoutInMinutes * 60 * 1000)

						onEnd(async (_, timeout) => {
							if (timeout) {
								done = true
								clearTimeout(jobTimeout)
								if (schedulaFotaTimeout !== undefined)
									clearTimeout(schedulaFotaTimeout)
								warn('Device read timeout occurred.')
								resolve({
									connected,
									timeout: true,
									abort: false,
									deviceLog,
									flashLog,
								})
							}
							await flash({
								hexfile: atHost,
								...log({
									withTimestamp: true,
									prefixes: ['Resetting device with AT Host'],
								}),
							})
						})

						const mfwv = (await connection.at('AT+CGMR'))[0]
						if (mfwv !== undefined) {
							progress(`Firmware version:`, mfwv)
							const v = mfwv.split('_')[2]
							if (semver.satisfies(v, '>=1.3.0')) {
								progress(`Resetting modem settings`, port ?? defaultPort)
								await connection.at('AT%XFACTORYRESET=0')
							} else {
								warn(`Please update your modem firmware!`)
							}
						}

						progress('Provisioning credentials')
						// Turn off modem
						await connection.at('AT+CFUN=4')
						// 0 – Root CA certificate (ASCII text)
						await connection.at(
							`AT%CMNG=0,${secTag},0,"${credentials.caCert.replace(
								/\n/g,
								'\r\n',
							)}"`,
						)
						// 1 – Client certificate (ASCII text)
						await connection.at(
							`AT%CMNG=0,${secTag},1,"${credentials.clientCert.replace(
								/\n/g,
								'\r\n',
							)}"`,
						)
						// 2 – Client private key (ASCII text)
						await connection.at(
							`AT%CMNG=0,${secTag},2,"${credentials.privateKey.replace(
								/\n/g,
								'\r\n',
							)}"`,
						)
						// Turn on modem
						await connection.at('AT+CFUN=1')

						flashLog = await flash({
							hexfile: hexFile,
							...log({
								withTimestamp: true,
								prefixes: ['Flash Firmware'],
							}),
						})

						const terminateOn = (
							type: 'abortOn' | 'endOn',
							s: string[],
							t: (s: string[]) => (s: string) => boolean,
						) => {
							progress(
								`<${type}>`,
								`Setting up ${type} traps. Job will terminate if output contains:`,
							)
							s?.map((s) => progress(`<${type}>`, s))
							const terminateCheck = t(s)
							onData(async (data) => {
								s?.forEach(async (s) => {
									if (data.includes(s)) {
										warn(`<${type}>`, 'Termination criteria seen:', s)
									}
								})
								if (terminateCheck(data)) {
									if (!done) {
										done = true
										warn(
											`<${type}>`,
											'All termination criteria have been seen.',
										)
										clearTimeout(jobTimeout)
										if (schedulaFotaTimeout !== undefined)
											clearTimeout(schedulaFotaTimeout)
										if (type === 'endOn')
											await new Promise((resolve) =>
												setTimeout(
													resolve,
													(endOnWaitSeconds ?? 60) * 1000,
													[],
												),
											)
										await connection.end()
										resolve({
											connected,
											abort: type === 'abortOn',
											timeout: false,
											deviceLog,
											flashLog,
										})
									}
								}
							})
						}

						if (abortOn !== undefined) terminateOn('abortOn', abortOn, anySeen)
						if (endOn !== undefined) terminateOn('endOn', endOn, allSeen)

						// Schedule Firmware update, if device has connected
						const tryScheduleFota = async () => {
							if (
								await deviceHasConnected({
									deviceId,
									iotData,
								})
							) {
								connected = true

								// Upload FOTA file
								await s3.send(
									new PutObjectCommand({
										Bucket: bucketName,
										Key: fotaFileName,
										Body: await fs.readFile(fotaFile),
										ContentType: 'text/octet-stream',
									}),
								)

								// Schedula
								await schedulaFOTA({
									deviceId,
									iot,
									iotData,
									bucketName,
									appVersion,
									fotaFile,
									fotaFileName,
									region: awsConfig.region,
								})

								// Done, do not reschedule
								return
							}
							// Reschedule
							schedulaFotaTimeout = setTimeout(tryScheduleFota, 60 * 1000)
						}
						schedulaFotaTimeout = setTimeout(tryScheduleFota, 60 * 1000)
					})
					.catch(reject)
			})
			// Delete FOTA file
			if (connected) {
				await s3.send(
					new DeleteObjectCommand({
						Bucket: bucketName,
						Key: fotaFileName,
					}),
				)
			}

			await Promise.all([
				fs.writeFile(flashLogLocation, res.flashLog.join('\n'), 'utf-8'),
				fs.writeFile(deviceLogLocation, res.deviceLog.join('\n'), 'utf-8'),
			])
			return res
		} catch (error) {
			console.error(error)
			process.exit(-1)
		}
	}
}
